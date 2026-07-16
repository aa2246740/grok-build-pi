// Modified from xAI's Grok Build bridge test suite for the Pi port (2026).
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  claimJobTerminal,
  patchJobIfActive,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "../scripts/lib/state.mjs";
import { resolveJobKillTargets } from "../scripts/lib/tracked-jobs.mjs";

function withPluginData(fn) {
  const previous = process.env.GROK_PI_DATA;
  process.env.GROK_PI_DATA = makeTempDir();
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.GROK_PI_DATA;
    } else {
      process.env.GROK_PI_DATA = previous;
    }
  }
}

test("claimJobTerminal: cancelled wins over completed", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-cas-1";
    const running = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "CAS",
      bridgePid: 11,
      agentPid: 22,
      pid: 11
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const cancel = claimJobTerminal(workspace, jobId, "cancelled", {
      errorMessage: "Stopped by user."
    });
    assert.equal(cancel.claimed, true);
    assert.equal(cancel.status, "cancelled");

    const complete = claimJobTerminal(workspace, jobId, "completed", {
      result: { rawOutput: "too late" },
      rendered: "too late\n"
    });
    assert.equal(complete.claimed, false);
    assert.equal(complete.status, "cancelled");
    assert.equal(complete.reason, "cancelled-wins");

    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.status, "cancelled");
    assert.notEqual(stored.rendered, "too late\n");
  });
});

test("claimJobTerminal: late cancel does not clobber completed", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-cas-2";
    const running = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "CAS2",
      bridgePid: 11,
      agentPid: 22,
      pid: 11
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const complete = claimJobTerminal(workspace, jobId, "completed", {
      rendered: "done\n",
      result: { ok: true }
    });
    assert.equal(complete.claimed, true);
    assert.equal(complete.status, "completed");

    const cancel = claimJobTerminal(workspace, jobId, "cancelled", {
      errorMessage: "Stopped by user."
    });
    assert.equal(cancel.claimed, false);
    assert.equal(cancel.status, "completed");
    assert.equal(cancel.reason, "already-terminal");

    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.status, "completed");
    assert.equal(stored.rendered, "done\n");
  });
});

test("claimJobTerminal: missing job is not resurrected", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const claim = claimJobTerminal(workspace, "no-such-job", "completed", { rendered: "x" });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "missing");
    assert.equal(fs.existsSync(resolveJobFile(workspace, "no-such-job")), false);
  });
});

test("patchJobIfActive skips terminal jobs and preserves bridgePid when setting agentPid", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-patch-1";
    const running = {
      id: jobId,
      status: "running",
      phase: "starting",
      bridgePid: 5001,
      agentPid: null,
      pid: 5001
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const patched = patchJobIfActive(workspace, jobId, { agentPid: 9001, phase: "running" });
    assert.equal(patched.patched, true);
    assert.equal(patched.job.agentPid, 9001);
    assert.equal(patched.job.bridgePid, 5001);
    assert.equal(patched.job.pid, 5001);

    claimJobTerminal(workspace, jobId, "completed", { rendered: "ok\n" });
    const afterTerminal = patchJobIfActive(workspace, jobId, { phase: "should-not-apply" });
    assert.equal(afterTerminal.patched, false);
    assert.equal(afterTerminal.reason, "terminal");
    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.phase, "done");
  });
});

test("resolveJobKillTargets returns distinct agent and bridge pids, including legacy companionPid", () => {
  assert.deepEqual(
    resolveJobKillTargets({ agentPid: 2, bridgePid: 1, pid: 1 }).sort((a, b) => a - b),
    [1, 2]
  );
  assert.deepEqual(
    resolveJobKillTargets({ agentPid: 2, companionPid: 1, pid: 1 }).sort((a, b) => a - b),
    [1, 2]
  );
  assert.deepEqual(resolveJobKillTargets({ pid: 9 }), [9]);
  assert.deepEqual(resolveJobKillTargets({}), []);
});

test("stop retains verified targets until the post-kill cancelled claim", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-claim-kill-order";
    const running = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Order",
      bridgePid: 7001,
      agentPid: 7002,
      pid: 7001
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    // Capture targets before process termination; the later terminal claim
    // intentionally clears persisted PIDs only after a successful stop.
    const preClaimTargets = resolveJobKillTargets(running);
    assert.deepEqual(preClaimTargets.sort((a, b) => a - b), [7001, 7002]);

    const claim = claimJobTerminal(workspace, jobId, "cancelled", {
      errorMessage: "Stopped by user.",
      pid: null,
      agentPid: null,
      bridgePid: null
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.status, "cancelled");

    // After the post-kill claim, stored record has null pids.
    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.agentPid, null);
    assert.equal(stored.bridgePid, null);
    assert.deepEqual(resolveJobKillTargets(stored), []);
    assert.deepEqual(preClaimTargets.sort((a, b) => a - b), [7001, 7002]);

    // Late completed must not win after claim.
    const late = claimJobTerminal(workspace, jobId, "completed", { rendered: "nope\n" });
    assert.equal(late.claimed, false);
    assert.equal(late.reason, "cancelled-wins");
  });
});

test("patchJobIfActive does not resurrect terminal jobs when patching worker pid", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-enqueue-pid";
    const running = {
      id: jobId,
      status: "queued",
      phase: "queued",
      bridgePid: null,
      agentPid: null,
      pid: null
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    claimJobTerminal(workspace, jobId, "cancelled", { errorMessage: "stop" });
    const patched = patchJobIfActive(workspace, jobId, {
      bridgePid: 4242,
      pid: 4242,
      status: "queued"
    });
    assert.equal(patched.patched, false);
    assert.equal(patched.reason, "terminal");
    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.status, "cancelled");
    assert.notEqual(stored.bridgePid, 4242);
  });
});

test("cancellation intent blocks a competing completion claim", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-cancel-barrier";
    const running = {
      id: jobId,
      status: "running",
      phase: "stopping",
      cancelRequested: true,
      bridgePid: 11,
      agentPid: 22,
      pid: 11
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const completion = claimJobTerminal(workspace, jobId, "completed", { rendered: "too late\n" });
    assert.equal(completion.claimed, false);
    assert.equal(completion.reason, "cancel-pending");

    const cancellation = claimJobTerminal(workspace, jobId, "cancelled", {
      cancelRequested: false,
      bridgePid: null,
      agentPid: null,
      pid: null
    });
    assert.equal(cancellation.claimed, true);
    assert.equal(cancellation.status, "cancelled");
  });
});
