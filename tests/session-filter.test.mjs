import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusSnapshot } from "../scripts/lib/job-control.mjs";
import { upsertJob } from "../scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

test("runs stays session-scoped unless --all is requested", () => {
  const repo = makeTempDir();
  const dataDir = makeTempDir();
  const previousData = process.env.GROK_PI_DATA;
  const previousSession = process.env.GROK_PI_SESSION_ID;
  process.env.GROK_PI_DATA = dataDir;

  try {
    upsertJob(repo, { id: "run-a", status: "completed", sessionId: "session-a", summary: "a" });
    upsertJob(repo, { id: "run-b", status: "completed", sessionId: "session-b", summary: "b" });
    process.env.GROK_PI_SESSION_ID = "session-a";

    const scoped = buildStatusSnapshot(repo);
    const scopedIds = [scoped.latestFinished, ...scoped.recent].filter(Boolean).map((job) => job.id);
    assert.deepEqual(scopedIds, ["run-a"]);

    const all = buildStatusSnapshot(repo, { all: true });
    const allIds = [all.latestFinished, ...all.recent].filter(Boolean).map((job) => job.id).sort();
    assert.deepEqual(allIds, ["run-a", "run-b"]);
  } finally {
    if (previousData == null) delete process.env.GROK_PI_DATA;
    else process.env.GROK_PI_DATA = previousData;
    if (previousSession == null) delete process.env.GROK_PI_SESSION_ID;
    else process.env.GROK_PI_SESSION_ID = previousSession;
  }
});
