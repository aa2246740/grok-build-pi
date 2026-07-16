import fs from "node:fs";
// Modified from xAI's bridge runtime for Pi session identity and log labeling (2026).
import process from "node:process";

import { getProcessIdentity, verifyProcessIdentity } from "./process.mjs";

import {
  claimJobTerminal,
  isTerminalJobStatus,
  patchJobIfActive,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "GROK_PI_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const agentPidRaw = value.agentPid ?? null;
    const agentPid = Number.isFinite(Number(agentPidRaw)) ? Number(agentPidRaw) : null;
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      agentPid,
      agentIdentity:
        typeof value.agentIdentity === "string" && value.agentIdentity.trim()
          ? value.agentIdentity.trim()
          : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    agentPid: null,
    agentIdentity: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  if (!fs.existsSync(logFile)) return;
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "a"
  });
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  if (!fs.existsSync(logFile)) return;
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "a"
  });
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastAgentPid = null;
  let lastAgentIdentity = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = {};
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.agentPid && normalized.agentPid !== lastAgentPid) {
      lastAgentPid = normalized.agentPid;
      patch.agentPid = normalized.agentPid;
      changed = true;
    }

    if (normalized.agentIdentity && normalized.agentIdentity !== lastAgentIdentity) {
      lastAgentIdentity = normalized.agentIdentity;
      patch.agentIdentity = normalized.agentIdentity;
      changed = true;
    }

    if (!changed) {
      return;
    }

    patchJobIfActive(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[grok-pi] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

async function claimTerminalWithCancellationBarrier(workspaceRoot, jobId, status, patch) {
  let claim = claimJobTerminal(workspaceRoot, jobId, status, patch);
  for (let attempt = 0; claim.reason === "cancel-pending" && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    claim = claimJobTerminal(workspaceRoot, jobId, status, patch);
  }
  return claim;
}

export function resolveJobKillTargets(job = {}) {
  const targets = [];
  const seen = new Set();
  // Prefer bridgePid; accept legacy companionPid for older run records.
  for (const value of [job.agentPid, job.bridgePid, job.companionPid, job.pid]) {
    if (value == null || value === "") {
      continue;
    }
    const pid = Number(value);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    targets.push(pid);
  }
  return targets;
}

/** Build a kill plan that refuses stale or unverifiable persisted PIDs. */
export function buildJobKillPlan(job = {}, options = {}) {
  const candidates = [
    { role: "bridge", value: job.bridgePid, expectedIdentity: job.bridgeIdentity },
    {
      role: "companion",
      value: job.companionPid,
      expectedIdentity: job.companionIdentity ?? job.bridgeIdentity
    },
    { role: "legacy", value: job.pid, expectedIdentity: job.bridgeIdentity },
    { role: "agent", value: job.agentPid, expectedIdentity: job.agentIdentity }
  ];
  const seen = new Set();
  const plan = [];

  for (const candidate of candidates) {
    const pid = Number(candidate.value);
    if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    const verification = verifyProcessIdentity(pid, candidate.expectedIdentity, options);
    plan.push({
      pid,
      role: candidate.role,
      ...verification
    });
  }
  return plan;
}

export async function runTrackedJob(job, runner, options = {}) {
  const bridgePid = process.pid;
  const bridgeIdentity = getProcessIdentity(bridgePid);
  const logFile = options.logFile ?? job.logFile ?? null;
  const runningPatch = {
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    bridgePid,
    bridgeIdentity,
    pid: bridgePid,
    agentPid: job.agentPid ?? null,
    agentIdentity: job.agentIdentity ?? null,
    logFile
  };

  const activated = patchJobIfActive(job.workspaceRoot, job.id, runningPatch);
  if (!activated.patched) {
    if (activated.reason === "missing") {
      writeJobFile(job.workspaceRoot, job.id, {
        ...job,
        ...runningPatch,
        id: job.id
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        ...runningPatch,
        kind: job.kind,
        kindLabel: job.kindLabel,
        title: job.title,
        jobClass: job.jobClass,
        summary: job.summary,
        write: job.write,
        sessionId: job.sessionId
      });
      const recheck = patchJobIfActive(job.workspaceRoot, job.id, runningPatch);
      if (!recheck.patched && isTerminalJobStatus(recheck.status)) {
        return {
          exitStatus: 1,
          threadId: recheck.job?.threadId ?? null,
          turnId: null,
          payload: recheck.job?.result ?? { status: recheck.status },
          rendered: recheck.job?.rendered ?? `Run ${job.id} is already ${recheck.status}.\n`,
          summary: recheck.job?.summary ?? recheck.status,
          cancelled: recheck.status === "cancelled",
          pruned: false,
          alreadyTerminal: true
        };
      }
    } else if (isTerminalJobStatus(activated.status)) {
      return {
        exitStatus: 1,
        threadId: activated.job?.threadId ?? null,
        turnId: null,
        payload: activated.job?.result ?? { status: activated.status },
        rendered: activated.job?.rendered ?? `Run ${job.id} is already ${activated.status}.\n`,
        summary: activated.job?.summary ?? activated.status,
        cancelled: activated.status === "cancelled",
        pruned: false,
        alreadyTerminal: true
      };
    }
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const claim = await claimTerminalWithCancellationBarrier(job.workspaceRoot, job.id, completionStatus, {
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      result: execution.payload,
      rendered: execution.rendered,
      bridgePid,
      agentPid: null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      logFile: options.logFile ?? job.logFile ?? null
    });

    if (!claim.claimed && claim.status === "cancelled") {
      claimJobTerminal(job.workspaceRoot, job.id, "cancelled", {
        threadId: execution.threadId ?? claim.job?.threadId ?? null,
        turnId: execution.turnId ?? claim.job?.turnId ?? null,
        summary: claim.job?.summary ?? execution.summary,
        result: claim.job?.result ?? execution.payload,
        rendered: claim.job?.rendered ?? execution.rendered,
        partialResult: execution.payload,
        bridgePid: null,
        agentPid: null,
        pid: null,
        logFile: options.logFile ?? job.logFile ?? null
      });
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output (after cancel)", execution.rendered);
      return {
        ...execution,
        cancelled: true
      };
    }

    if (!claim.claimed && claim.reason === "missing") {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output (run missing)", execution.rendered);
      return {
        ...execution,
        pruned: true
      };
    }

    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const claim = await claimTerminalWithCancellationBarrier(job.workspaceRoot, job.id, "failed", {
      errorMessage,
      bridgePid: null,
      agentPid: null,
      pid: null,
      phase: "failed",
      logFile: options.logFile ?? job.logFile ?? null
    });

    if (!claim.claimed && claim.status === "cancelled") {
      throw error;
    }
    if (!claim.claimed && claim.reason === "missing") {
      throw error;
    }
    throw error;
  }
}

export { isTerminalJobStatus, claimJobTerminal, patchJobIfActive };
