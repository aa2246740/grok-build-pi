// Modified from xAI's session-lifecycle hook for the Pi extension lifecycle (2026).
import fs from "node:fs";

import { getProcessIdentity, terminateProcessTree } from "./process.mjs";
import { claimJobTerminal, loadState, patchJobIfActive, resolveStateFile, saveState } from "./state.mjs";
import { buildJobKillPlan, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export function cleanupSessionJobs(cwd, options = {}) {
  const sessionId = options.sessionId || process.env[SESSION_ID_ENV];
  if (!cwd || !sessionId) return { sessionId: sessionId ?? null, removed: 0, stopped: 0 };

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) return { sessionId, removed: 0, stopped: 0 };

  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  let stopped = 0;
  const removableIds = new Set(
    sessionJobs
      .filter((job) => job.status !== "queued" && job.status !== "running")
      .map((job) => job.id)
  );

  for (const job of sessionJobs) {
    if (job.status !== "queued" && job.status !== "running") continue;
    const latestJob = loadState(workspaceRoot).jobs.find((entry) => entry.id === job.id) ?? job;
    if (latestJob.status !== "queued" && latestJob.status !== "running") {
      removableIds.add(job.id);
      continue;
    }
    let killPlan = buildJobKillPlan(latestJob);
    if (killPlan.length === 0 || killPlan.some((entry) => !entry.verified)) {
      continue;
    }
    const intent = patchJobIfActive(workspaceRoot, job.id, {
      cancelRequested: true,
      cancelRequestedAt: new Date().toISOString(),
      phase: "stopping"
    });
    if (!intent.patched) {
      if (intent.status && intent.status !== "queued" && intent.status !== "running") {
        removableIds.add(job.id);
      }
      continue;
    }
    killPlan = buildJobKillPlan(intent.job);
    if (killPlan.length === 0 || killPlan.some((entry) => !entry.verified)) {
      patchJobIfActive(workspaceRoot, job.id, {
        cancelRequested: false,
        phase: latestJob.phase ?? latestJob.status
      });
      continue;
    }
    const killResults = [];
    for (const entry of killPlan) {
      try {
        const result = terminateProcessTree(entry.pid);
        const afterIdentity = getProcessIdentity(entry.pid);
        killResults.push({
          ...result,
          stopped: result.delivered || afterIdentity !== entry.expectedIdentity
        });
      } catch {
        killResults.push({ attempted: true, delivered: false, stopped: false });
      }
    }
    if (!killResults.every((result) => result.stopped)) {
      patchJobIfActive(workspaceRoot, job.id, {
        cancelRequested: false,
        phase: "stop-failed"
      });
      continue;
    }
    try {
      const claim = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
        errorMessage: "Stopped by Pi session shutdown.",
        phase: "cancelled",
        pid: null,
        agentPid: null,
        bridgePid: null,
        cancelRequested: false
      });
      if (claim.claimed || claim.status === "cancelled") {
        removableIds.add(job.id);
        stopped += 1;
      } else if (claim.status && claim.status !== "queued" && claim.status !== "running") {
        removableIds.add(job.id);
      }
    } catch {
    }
  }

  const nextState = loadState(workspaceRoot);
  saveState(workspaceRoot, {
    ...nextState,
    jobs: nextState.jobs.filter((job) => !removableIds.has(job.id))
  });
  return { sessionId, removed: removableIds.size, stopped };
}
