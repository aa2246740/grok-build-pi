import crypto from "node:crypto";
// Modified from xAI's bridge runtime to bound Pi handoff runs and disable CLI auto-update (2026).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, getProcessIdentity, runCommand, terminateProcessTree } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

const DEFAULT_BINARY = "grok";
const BINARY_ENV = "GROK_BINARY";
const DEFAULT_MAX_AGENT_OUTPUT_BYTES = 16 * 1024 * 1024;

export function resolveGrokBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

export function runGrok(args = [], options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  return runCommand(binary, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio
  });
}

export function getGrokAvailability(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const versionStatus = binaryAvailable(binary, ["version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    const alt = binaryAvailable(binary, ["--version"], { cwd, env: options.env });
    if (!alt.available) {
      return {
        available: false,
        detail: versionStatus.detail,
        binary
      };
    }
    return {
      available: true,
      detail: alt.detail,
      binary
    };
  }
  return {
    available: true,
    detail: versionStatus.detail,
    binary
  };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "models-probe",
    authMethod: null,
    verified: null,
    ...fields
  };
}

export function runModelsProbe(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const result = runGrok(["models"], {
    cwd,
    env: options.env,
    binary
  });

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return buildAuthStatus({
      available: false,
      loggedIn: false,
      detail: "grok binary not found",
      source: "availability"
    });
  }

  if (result.error) {
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: result.error.message,
      source: "models-probe"
    });
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: detail || "grok models failed; not logged in or not ready",
      source: "models-probe"
    });
  }

  const stdout = (result.stdout || "").trim();
  const loggedInHint = /logged in|available models|default model/i.test(stdout);
  return buildAuthStatus({
    available: true,
    loggedIn: true,
    detail: loggedInHint
      ? firstLine(stdout) || "grok models succeeded"
      : firstLine(stdout) || "grok models succeeded (treated as logged in)",
    source: "models-probe",
    authMethod: "grok-cli",
    verified: true
  });
}

export function getGrokAuthStatus(cwd, options = {}) {
  const availability = getGrokAvailability(cwd, options);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }
  return runModelsProbe(cwd, { ...options, binary: availability.binary });
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function buildHeadlessArgs(prompt, options = {}) {
  const args = ["--no-auto-update"];

  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  } else if (options.continueLast) {
    args.push("-c");
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  if (options.promptFile) {
    args.push("--prompt-file", options.promptFile);
  } else {
    args.push("-p", prompt);
  }

  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  if (options.alwaysApprove) {
    args.push("--always-approve");
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.maxTurns != null) {
    const maxTurns = Math.max(1, Math.floor(Number(options.maxTurns)));
    if (Number.isFinite(maxTurns)) {
      args.push("--max-turns", String(maxTurns));
    }
  }
  if (options.outputFormat) {
    args.push("--output-format", options.outputFormat);
  } else {
    args.push("--output-format", "plain");
  }
  if (options.jsonSchema) {
    const schemaText =
      typeof options.jsonSchema === "string" ? options.jsonSchema : JSON.stringify(options.jsonSchema);
    args.push("--json-schema", schemaText);
  }

  return args;
}

function createPrivatePromptFile(prompt, options = {}) {
  const parent = options.promptTempRoot ?? os.tmpdir();
  const tempDir = fs.mkdtempSync(path.join(parent, "grok-pi-prompt-"));
  try {
    fs.chmodSync(tempDir, 0o700);
  } catch {
  }
  const promptFile = path.join(tempDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
  return { tempDir, promptFile };
}

function removePrivatePromptFile(tempDir) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
  }
}

export function runHeadlessAgent(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!prompt) {
    return Promise.reject(new Error("A prompt is required for this Grok run."));
  }

  const sessionId = options.resumeSessionId
    ? options.resumeSessionId
    : options.sessionId || (options.assignSessionId === false ? null : crypto.randomUUID());

  let promptArtifact;
  try {
    promptArtifact = createPrivatePromptFile(prompt, options);
  } catch (error) {
    return Promise.reject(error);
  }

  const args = buildHeadlessArgs(prompt, {
    ...options,
    promptFile: promptArtifact.promptFile,
    cwd: options.cwd ?? cwd,
    sessionId: options.resumeSessionId || options.continueLast ? undefined : sessionId
  });

  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== "win32";

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached,
        windowsHide: true
      });
    } catch (error) {
      removePrivatePromptFile(promptArtifact.tempDir);
      reject(error);
      return;
    }

    const agentPid = child.pid ?? null;
    const agentIdentity = agentPid ? getProcessIdentity(agentPid) : null;
    emitProgress(options.onProgress, `Running grok (${binary}).`, "starting", {
      threadId: sessionId,
      agentPid,
      agentIdentity,
      pid: agentPid
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputExceeded = false;
    const maxOutputBytes = Math.max(1024, Number(options.maxOutputBytes) || DEFAULT_MAX_AGENT_OUTPUT_BYTES);

    const captureOutput = (target, chunk) => {
      if (outputExceeded) return;
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        if (agentPid) {
          try {
            terminateProcessTree(agentPid);
          } catch {
            child.kill("SIGTERM");
          }
        } else {
          child.kill("SIGTERM");
        }
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      captureOutput("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      captureOutput("stderr", chunk);
    });

    child.on("error", (error) => {
      removePrivatePromptFile(promptArtifact.tempDir);
      reject(error);
    });

    child.on("close", (code, signal) => {
      removePrivatePromptFile(promptArtifact.tempDir);
      const status = outputExceeded ? 1 : (code ?? (signal ? 1 : 0));
      if (outputExceeded) {
        stderr = `${stderr}${stderr ? "\n" : ""}Grok output exceeded ${maxOutputBytes} bytes and the process tree was stopped.`;
      }
      emitProgress(
        options.onProgress,
        status === 0 ? "Grok finished." : `Grok exited with status ${status}.`,
        status === 0 ? "finalizing" : "failed",
        { threadId: sessionId, agentPid, agentIdentity }
      );
      resolve({
        status,
        signal,
        stdout,
        stderr,
        sessionId,
        threadId: sessionId,
        agentPid,
        agentIdentity,
        finalMessage: stdout.trimEnd(),
        args,
        binary
      });
    });
  });
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  const text = String(rawOutput).trim();

  try {
    const decoded = JSON.parse(text);
    const parsed = unwrapHeadlessJsonEnvelope(decoded);
    return {
      ...fallback,
      parsed,
      parseError: null,
      rawOutput: text
    };
  } catch {
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(fenced[1].trim()),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(text.slice(start, end + 1)),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from Grok output.",
    rawOutput: text
  };
}

function unwrapHeadlessJsonEnvelope(decoded) {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return decoded;
  }

  const structured = decodeNestedJson(decoded.structuredOutput);
  if (structured && typeof structured === "object") {
    return structured;
  }

  const looksLikeEnvelope =
    Object.hasOwn(decoded, "stopReason") ||
    Object.hasOwn(decoded, "sessionId") ||
    Object.hasOwn(decoded, "requestId") ||
    Object.hasOwn(decoded, "structuredOutput");
  if (looksLikeEnvelope) {
    const nestedText = decodeNestedJson(decoded.text);
    if (nestedText && typeof nestedText === "object") {
      return nestedText;
    }
  }

  return decoded;
}

function decodeNestedJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return [
    "Return only valid JSON matching this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput, schemaInstructions = "" }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only inspection.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)",
    schemaInstructions ? `\n${schemaInstructions}` : ""
  ];
  return parts.filter((line) => line !== undefined).join("\n");
}
