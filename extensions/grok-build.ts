import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = join(EXTENSION_DIR, "..", "scripts", "grok-bridge.mjs");
const DATA_DIR = join(getAgentDir(), "extensions", "grok-build-pi");
const NODE_BINARY = process.env.GROK_NODE_BINARY?.trim() || "node";
const MESSAGE_TYPE = "grok-build";
const STATUS_KEY = "grok-build";
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

type BridgeContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

interface BridgeResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

interface BridgeRunOptions {
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  stopJobId?: string;
}

function splitArguments(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote) throw new Error(`Unterminated ${quote} quote in command arguments.`);
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function valueForFlag(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function prepareBridgeInvocation(args: string[]): { args: string[]; jobId?: string } {
  const [command, ...rest] = args;
  const prefixByCommand: Record<string, string> = {
    review: "review",
    critique: "review",
    run: "run",
    import: "transfer",
  };
  const prefix = prefixByCommand[command];
  if (!prefix) return { args };
  if (hasFlag(rest, "--job-id")) {
    throw new Error("--job-id is reserved for the Pi extension runtime.");
  }
  const jobId = `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  return {
    args: [command, "--job-id", jobId, ...rest],
    jobId,
  };
}

function bridgeEnvironment(ctx: BridgeContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GROK_PI_DATA: DATA_DIR,
    GROK_PI_SESSION_ID: ctx.sessionManager.getSessionId(),
    GROK_PI_TRANSCRIPT_PATH: ctx.sessionManager.getSessionFile() ?? "",
    GROK_PI_LEAF_ID: ctx.sessionManager.getLeafId() ?? "",
  };
}

function runBridge(
  args: string[],
  ctx: BridgeContext,
  options: BridgeRunOptions = {},
): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BINARY, [BRIDGE_SCRIPT, ...args], {
      cwd: ctx.cwd,
      env: bridgeEnvironment(ctx),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let killed = false;
    let lastProgressLine = "";
    let stopRequested = false;
    let childClosed = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();

    const clearStopTimers = () => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    };

    const launchExactStop = (attempt = 0) => {
      if (childClosed || !options.stopJobId) return;
      const stopper = spawn(NODE_BINARY, [BRIDGE_SCRIPT, "stop", options.stopJobId, "--json"], {
        cwd: ctx.cwd,
        env: bridgeEnvironment(ctx),
        stdio: "ignore",
        windowsHide: true,
      });
      let finished = false;
      const retry = () => {
        if (finished || childClosed) return;
        finished = true;
        if (attempt >= 4) return;
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          launchExactStop(attempt + 1);
        }, 100 * (attempt + 1));
        retryTimers.add(timer);
      };
      stopper.on("error", retry);
      stopper.on("close", (code) => {
        if (code !== 0) retry();
      });
    };

    const requestStop = () => {
      killed = true;
      if (stopRequested) return;
      stopRequested = true;
      if (!options.stopJobId) {
        child.kill("SIGTERM");
        return;
      }
      launchExactStop();
      // The exact-id stop normally terminates both the detached Grok process
      // and this bridge. Keep a bounded fallback for a pre-record creation race.
      forceKillTimer = setTimeout(() => {
        if (!childClosed) {
          launchExactStop(5);
        }
      }, 2000);
    };

    const capture = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      capturedBytes += Buffer.byteLength(text);
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        requestStop();
        return;
      }
      if (target === "stdout") stdout += text;
      else {
        stderr += text;
        const line = text
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)
          .at(-1);
        if (line && line !== lastProgressLine) {
          lastProgressLine = line;
          options.onProgress?.(line.replace(/^\[grok-pi\]\s*/, ""));
        }
      }
    };

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));

    const abort = () => {
      requestStop();
    };

    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      childClosed = true;
      clearStopTimers();
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      childClosed = true;
      clearStopTimers();
      options.signal?.removeEventListener("abort", abort);
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        stderr += `\nOutput exceeded ${MAX_CAPTURE_BYTES} bytes and the bridge was stopped.`;
      }
      resolve({ code: code ?? 1, stdout, stderr, killed });
    });
  });
}

function outputText(result: BridgeResult): string {
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (result.code === 0) return stdout || "Grok Build command completed.";
  // Bridge stdout contains the rendered Grok failure; stderr is primarily
  // progress. Preserve both, with the actionable rendered error first.
  const detail = [stdout, stderr].filter(Boolean).join("\n\n") || `Bridge exited with status ${result.code}.`;
  throw new Error(boundOutput(detail).text);
}

function sendOutput(pi: ExtensionAPI, content: string, details: Record<string, unknown>): void {
  const bounded = boundOutput(content);
  pi.sendMessage({
    customType: MESSAGE_TYPE,
    content: bounded.text,
    display: true,
    details: { ...details, truncation: bounded.truncation },
  });
}

function boundOutput(content: string): { text: string; truncation?: unknown } {
  const truncation = truncateHead(content, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return { text: content };
  return {
    text: `${truncation.content}\n\n[Output truncated for Pi context. Stored runs can be paged with /grok-build:show <run-id> --offset-bytes <n>.]`,
    truncation,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  label: string,
  bridgeArgs: string[],
): Promise<void> {
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, label);
    ctx.ui.setWorkingMessage(label);
  }
  try {
    const invocation = prepareBridgeInvocation(bridgeArgs);
    const result = await runBridge(invocation.args, ctx, {
      stopJobId: invocation.jobId,
      onProgress: (line) => {
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, line);
      },
    });
    sendOutput(pi, outputText(result), {
      command: bridgeArgs[0],
      args: bridgeArgs.slice(1),
      jobId: invocation.jobId,
      exitCode: result.code,
    });
  } catch (error) {
    const message = errorMessage(error);
    sendOutput(pi, `**Grok Build error**\n\n${message}`, {
      command: bridgeArgs[0],
      error: message,
    });
    if (ctx.hasUI) ctx.ui.notify(message, "error");
  } finally {
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWorkingMessage();
    }
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(stdout));
  });
}

async function recommendReviewMode(cwd: string, args: string[]): Promise<"wait" | "background"> {
  const base = valueForFlag(args, "--base");
  if (base) {
    const changed = await gitOutput(cwd, ["diff", "--name-only", `${base}...HEAD`]);
    const count = changed.split(/\r?\n/).filter(Boolean).length;
    return count > 0 && count <= 2 ? "wait" : "background";
  }
  const status = await gitOutput(cwd, ["status", "--short", "--untracked-files=all"]);
  const count = status.split(/\r?\n/).filter(Boolean).length;
  return count > 0 && count <= 2 ? "wait" : "background";
}

async function addReviewMode(
  ctx: ExtensionCommandContext,
  args: string[],
  kind: "review" | "critique",
): Promise<string[]> {
  if (hasFlag(args, "--wait", "--background")) return args;
  if (!ctx.hasUI) return ["--wait", ...args];

  const recommended = await recommendReviewMode(ctx.cwd, args);
  const waitLabel = `Wait for results${recommended === "wait" ? " (Recommended)" : ""}`;
  const backgroundLabel = `Run in background${recommended === "background" ? " (Recommended)" : ""}`;
  const choices = recommended === "wait" ? [waitLabel, backgroundLabel] : [backgroundLabel, waitLabel];
  const selected = await ctx.ui.select(`Run Grok Build ${kind}`, choices);
  if (!selected) throw new Error("Grok Build run cancelled.");
  return [selected.startsWith("Wait") ? "--wait" : "--background", ...args];
}

async function addDelegateResumeChoice(
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<string[]> {
  if (hasFlag(args, "--resume", "--resume-last", "--fresh")) return args;

  const probe = await runBridge(["run-resume-candidate", "--json"], ctx);
  if (probe.code !== 0) return args;
  let available = false;
  try {
    available = Boolean(JSON.parse(probe.stdout).available);
  } catch {
    return args;
  }
  if (!available) return args;
  if (!ctx.hasUI) return ["--fresh", ...args];

  const selected = await ctx.ui.select("Grok Build delegate thread", [
    "Start a new Grok thread (Recommended)",
    "Continue current Grok thread",
  ]);
  if (!selected) throw new Error("Grok Build delegation cancelled.");
  return [selected.startsWith("Continue") ? "--resume" : "--fresh", ...args];
}

function registerCommand(
  pi: ExtensionAPI,
  name: string,
  description: string,
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
): void {
  pi.registerCommand(name, { description, handler });
}

const ToolParameters = Type.Object({
  action: StringEnum(
    ["check", "review", "critique", "delegate", "transfer", "runs", "show", "stop"] as const,
    { description: "Grok Build operation to perform." },
  ),
  prompt: Type.Optional(Type.String({ description: "Task or critique focus text." })),
  base: Type.Optional(Type.String({ description: "Git base ref for review or critique." })),
  scope: Type.Optional(
    StringEnum(["auto", "working-tree", "branch"] as const, {
      description: "Review target selection.",
    }),
  ),
  mode: Type.Optional(
    StringEnum(["wait", "background"] as const, {
      description: "Wait for output or enqueue a background run.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Optional Grok model override." })),
  effort: Type.Optional(
    StringEnum(["low", "medium", "high"] as const, {
      description: "Optional Grok reasoning effort.",
    }),
  ),
  write: Type.Optional(
    Type.Boolean({
      description: "Run delegated Grok with --always-approve and the user's OS permissions.",
    }),
  ),
  resume: Type.Optional(Type.Boolean({ description: "Resume the last Grok delegate thread." })),
  runId: Type.Optional(Type.String({ description: "Run id for show, stop, or a single-run status query." })),
  all: Type.Optional(Type.Boolean({ description: "Include runs from other Pi sessions in this workspace." })),
});

function addOptionalFlags(
  args: string[],
  params: {
    base?: string;
    scope?: "auto" | "working-tree" | "branch";
    mode?: "wait" | "background";
    model?: string;
    effort?: "low" | "medium" | "high";
  },
): void {
  if (params.base) args.push("--base", params.base);
  if (params.scope) args.push("--scope", params.scope);
  if (params.mode) args.push(params.mode === "wait" ? "--wait" : "--background");
  if (params.model) args.push("--model", params.model);
  if (params.effort) args.push("--effort", params.effort);
}

export default function grokBuildExtension(pi: ExtensionAPI): void {
  registerCommand(pi, "grok-build:check", "Check Grok CLI availability and authentication", async (raw, ctx) => {
    await executeCommand(pi, ctx, "Checking Grok Build", ["check", ...splitArguments(raw)]);
  });

  registerCommand(pi, "grok-build:review", "Run a read-only Grok Build code review", async (raw, ctx) => {
    const args = await addReviewMode(ctx, splitArguments(raw), "review");
    await executeCommand(pi, ctx, "Running Grok Build review", ["review", ...args]);
  });

  registerCommand(pi, "grok-build:critique", "Challenge implementation and design choices with Grok Build", async (raw, ctx) => {
    const args = await addReviewMode(ctx, splitArguments(raw), "critique");
    await executeCommand(pi, ctx, "Running Grok Build critique", ["critique", ...args]);
  });

  registerCommand(pi, "grok-build:delegate", "Delegate a task to Grok Build (read-only unless --write)", async (raw, ctx) => {
    let args = splitArguments(raw);
    if (args.length === 0) {
      if (!ctx.hasUI) throw new Error("Provide a task for Grok Build.");
      const prompt = await ctx.ui.input("Grok Build task", "What should Grok investigate or implement?");
      if (!prompt?.trim()) return;
      args = [prompt.trim()];
    }
    args = await addDelegateResumeChoice(ctx, args);
    await executeCommand(pi, ctx, "Delegating to Grok Build", ["run", ...args]);
  });

  const handoff = async (raw: string, ctx: ExtensionCommandContext) => {
    await executeCommand(pi, ctx, "Transferring Pi session to Grok", ["import", ...splitArguments(raw)]);
  };
  registerCommand(pi, "grok-build:handoff", "Transfer the current Pi session into a resumable Grok thread", handoff);
  registerCommand(pi, "grok-build:import", "Compatibility alias for /grok-build:handoff", handoff);

  registerCommand(pi, "grok-build:runs", "List active and recent Grok Build runs", async (raw, ctx) => {
    await executeCommand(pi, ctx, "Loading Grok Build runs", ["runs", ...splitArguments(raw)]);
  });

  registerCommand(pi, "grok-build:show", "Show stored output for a Grok Build run", async (raw, ctx) => {
    await executeCommand(pi, ctx, "Loading Grok Build output", ["show", ...splitArguments(raw)]);
  });

  registerCommand(pi, "grok-build:stop", "Stop an active Grok Build run", async (raw, ctx) => {
    await executeCommand(pi, ctx, "Stopping Grok Build run", ["stop", ...splitArguments(raw)]);
  });

  pi.registerTool({
    name: "grok_build",
    label: "Grok Build",
    description:
      "Run the local Grok Build CLI for a user-requested second opinion, code review, critique, or delegated task. This sends repository or session context to Grok/xAI. Reviews are read-only; delegated writes require confirmation.",
    promptSnippet: "Use Grok Build for an explicitly requested external review, critique, or delegation.",
    promptGuidelines: [
      "Use grok_build only when the user explicitly asks to involve Grok Build or xAI; repository and session context may be sent to an external service.",
      "Keep grok_build review and critique read-only. Set write=true only for an explicit user request to run Grok with --always-approve and the user's OS permissions.",
    ],
    parameters: ToolParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.write && params.action !== "delegate") {
        throw new Error("write=true is supported only for the delegate action.");
      }

      const sendsContextExternally = ["review", "critique", "delegate", "transfer"].includes(
        params.action,
      );
      if (sendsContextExternally) {
        if (!ctx.hasUI) {
          throw new Error(
            "Sending context to Grok/xAI requires interactive confirmation. Use an explicit /grok-build:* command in Pi instead.",
          );
        }
        const title = params.write
          ? "Send context and allow Grok to write?"
          : params.action === "transfer"
            ? "Transfer this Pi session to Grok?"
            : "Send context to Grok/xAI?";
        const detail = params.write
          ? "Repository context will be sent to Grok/xAI. Grok will run without the bridge's read-only sandbox, with --always-approve and your OS permissions, so it may run commands or modify files outside this workspace."
          : params.action === "transfer"
            ? "The visible Pi transcript will be sent to Grok/xAI. Private thinking blocks are excluded."
            : "The requested prompt and relevant repository context may be sent to Grok/xAI. This run is read-only.";
        const confirmed = await ctx.ui.confirm(
          title,
          detail,
        );
        if (!confirmed) throw new Error("Sending context to Grok/xAI was not approved.");
      }

      const args: string[] = [];
      switch (params.action) {
        case "check":
          args.push("check");
          break;
        case "review":
        case "critique":
          args.push(params.action);
          addOptionalFlags(args, params);
          if (!params.mode) args.push("--wait");
          if (params.action === "critique" && params.prompt) args.push("--", params.prompt);
          break;
        case "delegate":
          if (!params.prompt && !params.resume) throw new Error("delegate requires prompt or resume=true.");
          args.push("run");
          if (params.mode === "background") args.push("--background");
          if (params.model) args.push("--model", params.model);
          if (params.effort) args.push("--effort", params.effort);
          if (params.write) args.push("--write");
          if (params.resume) args.push("--resume");
          else args.push("--fresh");
          if (params.prompt) args.push("--", params.prompt);
          break;
        case "transfer":
          args.push("import");
          if (params.model) args.push("--model", params.model);
          if (params.effort) args.push("--effort", params.effort);
          break;
        case "runs":
          args.push("runs");
          if (params.all) args.push("--all");
          if (params.runId) args.push("--", params.runId);
          break;
        case "show":
        case "stop":
          args.push(params.action);
          if (params.runId) args.push("--", params.runId);
          break;
      }

      const invocation = prepareBridgeInvocation(args);
      const result = await runBridge(invocation.args, ctx, {
        signal,
        stopJobId: invocation.jobId,
        onProgress: (line) => {
          onUpdate?.({
            content: [{ type: "text", text: line }],
            details: { action: params.action, progress: line },
          });
        },
      });
      const bounded = boundOutput(outputText(result));
      return {
        content: [{ type: "text", text: bounded.text }],
        details: {
          action: params.action,
          jobId: invocation.jobId,
          exitCode: result.code,
          killed: result.killed,
          stderr: result.stderr.trimEnd() || undefined,
          truncation: bounded.truncation,
        },
      };
    },
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    try {
      await runBridge(["session-cleanup", "--json"], ctx);
    } catch {
      // Shutdown cleanup is best effort; the persisted run state remains usable
      // if the process exits before the bridge can claim it.
    }
  });
}
