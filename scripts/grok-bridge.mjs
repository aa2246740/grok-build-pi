#!/usr/bin/env node

// Modified from xAI's Grok Build Claude Code bridge for the Pi host adapter (2026).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildReviewPrompt,
  DEFAULT_CONTINUE_PROMPT,
  getGrokAuthStatus,
  getGrokAvailability,
  parseStructuredOutput,
  readOutputSchema,
  runHeadlessAgent,
  schemaInstructionsFromPath
} from "./lib/grok.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForSession,
  getSessionRuntimeStatus,
  readStoredJob,
  resolveCancelableJob,
  resolveJobKindLabel,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { binaryAvailable, getProcessIdentity, terminateProcessTree } from "./lib/process.mjs";
import { buildPiTransferPrompt, readPiSession, resolvePiSessionPath } from "./lib/pi-session-transfer.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { cleanupSessionJobs } from "./lib/session-lifecycle.mjs";
import {
  claimJobTerminal,
  generateJobId,
  listJobs,
  normalizeJobId,
  patchJobIfActive,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  buildJobKillPlan,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-bridge.mjs check [--json]",
      "  node scripts/grok-bridge.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high>]",
      "  node scripts/grok-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high>] [focus text]",
      "  node scripts/grok-bridge.mjs run [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [prompt]",
      "  node scripts/grok-bridge.mjs import [--source <pi-jsonl>] [--max-chars <n>] [--model <model>] [--effort <low|medium|high>] [--json]",
      "  node scripts/grok-bridge.mjs runs [run-id] [--all] [--json]",
      "  node scripts/grok-bridge.mjs show [run-id] [--json]",
      "  node scripts/grok-bridge.mjs stop [run-id] [--json]",
      "  node scripts/grok-bridge.mjs session-cleanup [--session-id <id>] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high.`
    );
  }
  return normalized;
}

function normalizeModelName(model) {
  if (model == null) return null;
  const normalized = String(model).trim();
  if (!MODEL_NAME_PATTERN.test(normalized)) {
    throw new Error("Invalid model name. Use letters, numbers, dots, underscores, colons, slashes, or hyphens.");
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    unknownMode: config.unknownMode ?? "warn",
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  if (parsed.unknown?.length) {
    for (const token of parsed.unknown) {
      process.stderr.write(`Warning: ignoring unknown option ${token}\n`);
    }
  }
  return parsed;
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildCheckReport(cwd, actionsTaken = []) {
  const nodeStatus = binaryAvailable(process.env.GROK_NODE_BINARY || process.execPath, ["--version"], { cwd });
  const grokStatus = getGrokAvailability(cwd);
  const authStatus = getGrokAuthStatus(cwd);

  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push("Install the Grok Build CLI and ensure `grok` is on PATH (or set GROK_BINARY).");
  }
  if (grokStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Authenticate the Grok CLI (for example by running `grok` interactively and completing login).");
    nextSteps.push("Verify with `grok models` — a successful run means you are logged in.");
  }

  return {
    ready: nodeStatus.available && grokStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    actionsTaken,
    nextSteps
  };
}

async function handleCheck(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const finalReport = await buildCheckReport(cwd, []);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildCritiquePrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "critique");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Critique",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureGrokAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Grok CLI is not installed or not on PATH. Install it, set GROK_BINARY if needed, then rerun `/grok-build:check`."
    );
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentPiSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentPiSession(jobs) {
  return filterJobsForSession(jobs, { sessionId: getCurrentPiSessionId() });
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentPiSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Delegate run ${activeTask.id} is still running. Use /grok-build:runs before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  return null;
}

async function executeReviewRun(request) {
  ensureGrokAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);

  let prompt;
  let structured = false;
  if (reviewName === "Critique") {
    prompt = buildCritiquePrompt(context, focusText);
    const schemaHint = schemaInstructionsFromPath(REVIEW_SCHEMA);
    if (schemaHint) {
      prompt = `${prompt}\n\n${schemaHint}`;
    }
    structured = true;
  } else {
    prompt = buildReviewPrompt({
      targetLabel: context.target.label,
      focusText,
      collectionGuidance: context.collectionGuidance,
      reviewInput: context.content
    });
  }

  const result = await runHeadlessAgent(context.repoRoot, {
    prompt,
    agent: "explore",
    permissionMode: "plan",
    sandbox: "read-only",
    model: request.model,
    effort: request.effort,
    outputFormat: structured ? "json" : "plain",
    jsonSchema: structured ? readOutputSchema(REVIEW_SCHEMA) : undefined,
    onProgress: request.onProgress
  });

  if (structured) {
    const parsed = parseStructuredOutput(result.finalMessage, {
      status: result.status,
      failureMessage: result.stderr
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      context: {
        repoRoot: context.repoRoot,
        branch: context.branch,
        summary: context.summary
      },
      grok: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.finalMessage
      },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError
    };

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: null,
      payload,
      rendered: renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label
      }),
      summary:
        parsed.parsed?.summary ??
        parsed.parseError ??
        firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
      jobTitle: `Grok Build ${reviewName}`,
      jobClass: "review",
      targetLabel: context.target.label
    };
  }

  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    grok: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage
    }
  };
  const rendered = renderNativeReviewResult(
    {
      status: result.status,
      stdout: result.finalMessage,
      stderr: result.stderr
    },
    { reviewLabel: reviewName, targetLabel: target.label }
  );

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: null,
    payload,
    rendered,
    summary: firstMeaningfulLine(result.finalMessage, `${reviewName} completed.`),
    jobTitle: `Grok Build ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeSessionId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Grok Build delegate session was found for this repository.");
    }
    resumeSessionId = latestThread.id;
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const prompt = String(request.prompt ?? "").trim() || (resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "");
  const write = Boolean(request.write);

  const result = await runHeadlessAgent(workspaceRoot, {
    prompt,
    resumeSessionId,
    agent: write ? undefined : "explore",
    model: request.model,
    effort: request.effort,
    alwaysApprove: write,
    permissionMode: write ? undefined : "plan",
    sandbox: write ? undefined : "read-only",
    outputFormat: "plain",
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.status === 0 ? "" : result.stderr || "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: null,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Critique" ? "critique" : "review",
    title: reviewName === "Review" ? "Grok Build Review" : `Grok Build ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Grok Build Resume" : "Grok Build Delegate";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Delegate";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /grok-build:runs ${payload.jobId} for progress.\n`;
}

function createBridgeJob({ prefix, id = null, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  const jobId = id == null ? generateJobId(prefix) : normalizeJobId(id);
  if (readStoredJob(workspaceRoot, jobId) || listJobs(workspaceRoot).some((job) => job.id === jobId)) {
    throw new Error(`Run id ${jobId} already exists.`);
  }
  return createJobRecord({
    id: jobId,
    kind,
    kindLabel: resolveJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, jobId = null) {
  return createBridgeJob({
    prefix: "run",
    id: jobId,
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the current Pi session context into a Grok session.",
    payload.threadId ? `Grok session ID: ${payload.threadId}` : "Grok session ID: (not detected in transfer output)",
    payload.resumeCommand ? `Resume in Grok: ${payload.resumeCommand}` : "Resume with: grok -r <session-id>",
    "Private thinking blocks: excluded",
    `Transcript truncated: ${payload.transfer.truncated ? "yes" : "no"}`,
    "",
    "Grok handoff acknowledgement:",
    payload.acknowledgement || "(no acknowledgement returned)"
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  ensureGrokAvailable(cwd);
  const sourcePath = resolvePiSessionPath(cwd, {
    source: options.source
  });
  const session = readPiSession(sourcePath, {
    leafId: options.leafId,
    useEnvLeaf: !options.source
  });
  const transfer = buildPiTransferPrompt(session, { maxChars: options.maxChars });
  const { prompt: transferPrompt, ...transferMetadata } = transfer;
  const result = await runHeadlessAgent(cwd, {
    prompt: transferPrompt,
    agent: "explore",
    permissionMode: "plan",
    sandbox: "read-only",
    outputFormat: "plain",
    model: options.model,
    effort: options.effort,
    maxTurns: 1,
    onProgress: options.onProgress
  });
  const payload = {
    threadId: result.threadId,
    resumeCommand: result.threadId ? `grok -r ${result.threadId}` : null,
    sourcePath,
    sessionId: session.header.id ?? path.basename(sourcePath, ".jsonl"),
    piLeafId: session.resolvedLeaf,
    transfer: transferMetadata,
    acknowledgement: result.finalMessage,
    stderr: result.stderr
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: null,
    payload,
    rendered: renderTransferResult(payload),
    summary: firstMeaningfulLine(result.finalMessage, "Pi session context transferred to Grok."),
    jobTitle: "Grok Build Pi Session Transfer",
    jobClass: "task"
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedRunWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-bridge.mjs");
  const child = spawn(process.execPath, [scriptPath, "run-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

export function enqueueBackgroundJob(cwd, job, request, options = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    agentPid: null,
    agentIdentity: null,
    bridgePid: null,
    bridgeIdentity: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const spawnWorker = options.spawnWorker ?? spawnDetachedRunWorker;
  const child = spawnWorker(cwd, job.id);
  const workerPid = child?.pid ?? null;
  const workerIdentity = workerPid != null ? getProcessIdentity(workerPid) : null;
  if (workerPid != null) {
    patchJobIfActive(job.workspaceRoot, job.id, {
      status: "queued",
      phase: "queued",
      pid: workerPid,
      bridgePid: workerPid,
      bridgeIdentity: workerIdentity,
      agentPid: null,
      agentIdentity: null,
      logFile,
      request
    });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      bridgePid: workerPid,
      bridgeIdentity: workerIdentity,
      pid: workerPid
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd", "job-id"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeModelName(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createBridgeJob({
    prefix: "review",
    id: options["job-id"],
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  const request = {
    kind: "review",
    cwd,
    base: options.base,
    scope: options.scope,
    model,
    effort,
    focusText,
    reviewName: config.reviewName
  };

  if (options.background && !options.wait) {
    ensureGrokAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "job-id"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeModelName(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureGrokAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, options["job-id"]);
    const request = {
      kind: "task",
      ...buildTaskRequest({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id
      })
    };
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, options["job-id"]);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source", "max-chars", "leaf-id", "model", "effort", "job-id"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const job = createBridgeJob({
    prefix: "transfer",
    id: options["job-id"],
    kind: "transfer",
    title: "Grok Build Pi Session Transfer",
    workspaceRoot,
    jobClass: "task",
    summary: "Transfer the active Pi session branch to a resumable Grok thread"
  });
  await runForegroundCommand(job, (progress) => executeTransfer(cwd, {
    source: options.source,
    maxChars: options["max-chars"],
    leafId: options["leaf-id"],
    model: normalizeModelName(options.model),
    effort: normalizeReasoningEffort(options.effort),
    onProgress: progress
  }), { json: options.json });
}

async function readStoredJobWithRetry(workspaceRoot, jobId, options = {}) {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 25;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = readStoredJob(workspaceRoot, jobId);
    if (last) {
      return last;
    }
    await sleep(delayMs);
  }
  return last;
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for run-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = await readStoredJobWithRetry(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its run request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );

  const runner =
    request.kind === "review" || storedJob.jobClass === "review"
      ? () => executeReviewRun({ ...request, onProgress: progress })
      : () => executeTaskRun({ ...request, onProgress: progress });

  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    runner,
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`runs --wait` requires a run id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "offset-bytes", "max-bytes", "max-lines"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const rendered = renderStoredJobResult(job, storedJob);
  const buffer = Buffer.from(rendered, "utf8");
  const requestedOffset = Math.max(0, Math.floor(Number(options["offset-bytes"]) || 0));
  let startByte = Math.min(requestedOffset, buffer.length);
  while (startByte < buffer.length && (buffer[startByte] & 0xc0) === 0x80) startByte += 1;
  const requestedMax = Math.floor(Number(options["max-bytes"]) || 40_000);
  const maxBytes = Math.min(40_000, Math.max(1024, requestedMax));
  const requestedMaxLines = Math.floor(Number(options["max-lines"]) || 1800);
  const maxLines = Math.min(1800, Math.max(1, requestedMaxLines));
  let endByte = Math.min(buffer.length, startByte + maxBytes);
  while (endByte > startByte && endByte < buffer.length && (buffer[endByte] & 0xc0) === 0x80) endByte -= 1;
  let newlineCount = 0;
  for (let index = startByte; index < endByte; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    newlineCount += 1;
    if (newlineCount >= maxLines) {
      endByte = index + 1;
      break;
    }
  }
  const pageContent = buffer.subarray(startByte, endByte).toString("utf8");
  const nextOffsetBytes = endByte < buffer.length ? endByte : null;
  const pagination = {
    startByte,
    endByte,
    totalBytes: buffer.length,
    nextOffsetBytes,
    maxBytes,
    maxLines
  };
  const payload = {
    job: {
      id: job.id,
      status: job.status,
      title: job.title ?? null,
      summary: job.summary ?? null,
      kind: job.kind ?? null,
      kindLabel: job.kindLabel ?? null,
      threadId: storedJob?.threadId ?? job.threadId ?? null,
      completedAt: job.completedAt ?? null
    },
    page: pageContent,
    pagination
  };

  const pageFooter = nextOffsetBytes == null
    ? ""
    : `\n\n[More output available. Continue with /grok-build:show ${job.id} --offset-bytes ${nextOffsetBytes}]\n`;

  outputCommandResult(payload, `${pageContent}${pageFooter}`, options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentPiSessionId();
  const jobs = filterJobsForCurrentPiSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable delegate run found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable delegate run found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function handleSessionCleanup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "session-id"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const payload = cleanupSessionJobs(cwd, { sessionId: options["session-id"] });
  outputCommandResult(
    payload,
    `Cleaned up ${payload.removed} Grok Build run(s) for Pi session ${payload.sessionId ?? "(unknown)"}.\n`,
    options.json
  );
}

function terminateJobProcessTrees(job, options = {}) {
  const verification = options.verification ?? buildJobKillPlan(job);
  const targets = verification.filter((entry) => entry.verified).map((entry) => entry.pid);
  const results = [];
  for (const pid of targets) {
    const expectedIdentity = verification.find((entry) => entry.pid === pid)?.expectedIdentity ?? null;
    const outcome = terminateProcessTree(pid);
    const afterIdentity = getProcessIdentity(pid);
    results.push({
      pid,
      ...outcome,
      afterIdentity,
      stopped: outcome.delivered || afterIdentity !== expectedIdentity
    });
  }
  if (results.length === 0) {
    return { attempted: false, delivered: false, method: null, results: [], verification };
  }
  return {
    attempted: results.some((entry) => entry.attempted),
    delivered: results.some((entry) => entry.delivered),
    method: results.map((entry) => entry.method).filter(Boolean).join("+") || null,
    results,
    verification
  };
}

function activeJobStatus(status) {
  return status === "queued" || status === "running";
}

function allKillTargetsVerified(verification) {
  return verification.length > 0 && verification.every((entry) => entry.verified);
}

function allVerifiedTargetsStopped(killResult) {
  return (
    killResult.verification.length > 0 &&
    killResult.results.length === killResult.verification.length &&
    killResult.results.every((entry) => entry.stopped)
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? job;
  if (!activeJobStatus(existing.status)) {
    const payload = {
      jobId: job.id,
      status: existing.status,
      title: existing.title ?? job.title,
      killAttempted: false,
      killDelivered: false,
      alreadyTerminal: true,
      claimOrder: "kill-before-claim",
      killTargets: [],
      killVerification: []
    };
    outputCommandResult(payload, `Job ${job.id} is already ${existing.status}; no process was signalled.\n`, options.json);
    return;
  }

  // Re-read immediately before verification so a just-completed worker is
  // never killed from a stale active snapshot.
  const latest = readStoredJob(workspaceRoot, job.id) ?? existing;
  if (!activeJobStatus(latest.status)) {
    const payload = {
      jobId: job.id,
      status: latest.status,
      title: latest.title ?? job.title,
      killAttempted: false,
      killDelivered: false,
      alreadyTerminal: true,
      claimOrder: "kill-before-claim",
      killTargets: [],
      killVerification: []
    };
    outputCommandResult(payload, `Job ${job.id} is already ${latest.status}; no process was signalled.\n`, options.json);
    return;
  }

  let preKillRecord = { ...job, ...latest };
  let killVerification = buildJobKillPlan(preKillRecord);
  let killTargets = killVerification.filter((entry) => entry.verified).map((entry) => entry.pid);
  if (!allKillTargetsVerified(killVerification)) {
    const payload = {
      jobId: job.id,
      status: latest.status,
      title: latest.title ?? job.title,
      killAttempted: false,
      killDelivered: false,
      stopFailed: true,
      claimOrder: "kill-before-claim",
      killTargets,
      killVerification
    };
    outputCommandResult(
      payload,
      `Unable to safely stop ${job.id}: one or more process identities could not be verified. The run remains ${latest.status}.\n`,
      options.json
    );
    process.exitCode = 1;
    return;
  }

  // Atomically install a cancellation barrier. A worker completion that wins
  // before this patch prevents any signal; one that loses cannot claim a
  // competing terminal status while stop is terminating its process trees.
  const intent = patchJobIfActive(workspaceRoot, job.id, {
    cancelRequested: true,
    cancelRequestedAt: nowIso(),
    phase: "stopping"
  });
  if (!intent.patched) {
    const payload = {
      jobId: job.id,
      status: intent.status,
      title: intent.job?.title ?? latest.title ?? job.title,
      killAttempted: false,
      killDelivered: false,
      alreadyTerminal: true,
      claimOrder: "cancel-barrier-then-kill",
      killTargets: [],
      killVerification: []
    };
    outputCommandResult(payload, `Job ${job.id} became ${intent.status}; no process was signalled.\n`, options.json);
    return;
  }

  preKillRecord = { ...preKillRecord, ...intent.job };
  killVerification = buildJobKillPlan(preKillRecord);
  killTargets = killVerification.filter((entry) => entry.verified).map((entry) => entry.pid);
  if (!allKillTargetsVerified(killVerification)) {
    patchJobIfActive(workspaceRoot, job.id, {
      cancelRequested: false,
      phase: latest.phase ?? latest.status,
      errorMessage: "Stop aborted because process identity changed or became unavailable."
    });
    const payload = {
      jobId: job.id,
      status: latest.status,
      title: latest.title ?? job.title,
      killAttempted: false,
      killDelivered: false,
      stopFailed: true,
      claimOrder: "cancel-barrier-then-kill",
      killTargets,
      killVerification
    };
    outputCommandResult(
      payload,
      `Unable to safely stop ${job.id}: process identity changed during cancellation. The run remains ${latest.status}.\n`,
      options.json
    );
    process.exitCode = 1;
    return;
  }

  const killResult = terminateJobProcessTrees(preKillRecord, { verification: killVerification });
  const stopped = allVerifiedTargetsStopped(killResult);

  if (!stopped) {
    patchJobIfActive(workspaceRoot, job.id, {
      cancelRequested: false,
      phase: "stop-failed",
      errorMessage: "Stop requested but one or more verified process trees could not be terminated.",
      cancelKill: killResult
    });
    const payload = {
      jobId: job.id,
      status: latest.status,
      title: latest.title ?? job.title,
      killAttempted: killResult.attempted,
      killDelivered: false,
      stopFailed: true,
      claimOrder: "kill-before-claim",
      killTargets,
      killVerification
    };
    outputCommandResult(
      payload,
      `Unable to stop every process for ${job.id}; the run record and process identities were preserved for retry.\n`,
      options.json
    );
    process.exitCode = 1;
    return;
  }

  const claim = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: "Stopped by user.",
    phase: "cancelled",
    pid: null,
    agentPid: null,
    bridgePid: null,
    cancelRequested: false,
    cancelKill: killResult,
    logFile: latest.logFile ?? job.logFile ?? null
  });

  if (!claim.claimed && claim.status !== "cancelled") {
    const payload = {
      jobId: job.id,
      status: claim.status,
      title: claim.job?.title ?? latest.title ?? job.title,
      killAttempted: killResult.attempted,
      killDelivered: killResult.delivered,
      alreadyTerminal: true,
      claimOrder: "cancel-barrier-then-kill",
      killTargets,
      killVerification
    };
    outputCommandResult(
      payload,
      `Job ${job.id} became ${claim.status} before cancellation could be recorded.\n`,
      options.json
    );
    return;
  }

  appendLogLine(
    latest.logFile ?? job.logFile,
    "Stopped by user after verified process-tree termination."
  );

  const nextJob = claim.job ?? {
    ...latest,
    status: "cancelled",
    phase: "cancelled",
    title: job.title
  };
  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    killAttempted: killResult.attempted,
    killDelivered: stopped,
    killMethod: killResult.method,
    killTargets,
    killVerification,
    claimOrder: "cancel-barrier-then-kill",
    claimed: claim.claimed
  };

  outputCommandResult(payload, renderCancelReport({ ...nextJob, ...payload }), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "check":
      await handleCheck(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "critique":
      await handleReviewCommand(argv, {
        reviewName: "Critique"
      });
      break;
    case "run":
      await handleTask(argv);
      break;
    case "import":
      await handleTransfer(argv);
      break;
    case "run-worker":
      await handleTaskWorker(argv);
      break;
    case "runs":
      await handleStatus(argv);
      break;
    case "show":
      handleResult(argv);
      break;
    case "run-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "stop":
      await handleCancel(argv);
      break;
    case "session-cleanup":
      handleSessionCleanup(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { main, readStoredJobWithRetry };
