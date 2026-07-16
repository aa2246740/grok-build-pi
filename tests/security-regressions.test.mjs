import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { runHeadlessAgent } from "../scripts/lib/grok.mjs";
import { buildPiTransferPrompt } from "../scripts/lib/pi-session-transfer.mjs";
import { verifyProcessIdentity } from "../scripts/lib/process.mjs";
import {
  listJobs,
  loadState,
  saveState,
  upsertJob,
  writeJobFile
} from "../scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(ROOT, "scripts", "grok-bridge.mjs");
const GIT_MODULE_URL = pathToFileURL(path.join(ROOT, "scripts", "lib", "git.mjs")).href;

function pluginEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    GROK_PI_DATA: pluginDataDir,
    ...extra
  });
}

function readFakeGrokInvocations(logPath) {
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("untracked symlinks and FIFOs are skipped without disclosure or blocking", (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link and FIFO behavior is POSIX-specific");
    return;
  }

  const repo = makeTempDir("grok-pi-security-repo-");
  const outside = makeTempDir("grok-pi-security-outside-");
  const secret = "OUTSIDE_SECRET_MUST_NOT_BE_DISCLOSED";
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  run("git", ["add", "tracked.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const outsideFile = path.join(outside, "secret.txt");
  fs.writeFileSync(outsideFile, `${secret}\n`);
  fs.symlinkSync(outsideFile, path.join(repo, "leak.txt"));
  const fifo = run("mkfifo", [path.join(repo, "input.pipe")]);
  assert.equal(fifo.status, 0, fifo.stderr);

  // Run collection in a child with a hard timeout: a regression that opens a
  // FIFO as an ordinary file must fail this test instead of hanging the suite.
  const source = `
    import { collectReviewContext } from ${JSON.stringify(GIT_MODULE_URL)};
    const context = collectReviewContext(process.argv[1], {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    }, { includeDiff: true });
    process.stdout.write(context.content);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, repo], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true
  });

  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.match(result.stdout, /leak\.txt[\s\S]*skipped: symbolic link/i);
  // Git itself omits special files from its untracked-file listing. The
  // important invariant is that collection returns promptly and never tries
  // to read or disclose the FIFO.
  assert.doesNotMatch(result.stdout, /input\.pipe/);
});

test("bridge rejects path-traversing job ids before creating run state", () => {
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  initGitRepo(repo);

  const result = run(
    process.execPath,
    [BRIDGE, "run", "--job-id", "../../escaped", "--json", "safe prompt"],
    {
      cwd: repo,
      env: { ...process.env, GROK_PI_DATA: pluginDataDir }
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Invalid job id/i);
  assert.equal(fs.existsSync(path.join(pluginDataDir, "escaped.json")), false);
});

test("run passthrough keeps --write=true literal and does not enable approval", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const logPath = path.join(pluginDataDir, "fake-grok.log");
  const fakeGrok = installFakeGrok(binDir);
  const captureGrok = path.join(binDir, "grok-capture");
  writeExecutable(captureGrok, `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
const promptFileIndex = argv.indexOf("--prompt-file");
const capturedPrompt = promptFileIndex === -1
  ? null
  : fs.readFileSync(argv[promptFileIndex + 1], "utf8");
if (process.env.FAKE_GROK_LOG) {
  fs.appendFileSync(process.env.FAKE_GROK_LOG, JSON.stringify({ argv, capturedPrompt }) + "\\n");
}
const result = spawnSync(${JSON.stringify(fakeGrok)}, argv, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
process.exit(result.status ?? 1);
`);
  initGitRepo(repo);

  const result = run(process.execPath, [BRIDGE, "run", "--json", "--", "--write=true"], {
    cwd: repo,
    env: pluginEnv(pluginDataDir, binDir, {
      FAKE_GROK_LOG: logPath,
      GROK_BINARY: captureGrok
    })
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const invocation = readFakeGrokInvocations(logPath)
    .reverse()
    .find((entry) => entry.capturedPrompt != null);
  assert.ok(invocation, "expected a headless fake-grok invocation");
  assert.equal(invocation.capturedPrompt, "--write=true");
  assert.equal(invocation.argv.includes("--always-approve"), false);
  assert.equal(invocation.argv.includes("--permission-mode"), true);
  assert.equal(invocation.argv[invocation.argv.indexOf("--permission-mode") + 1], "plan");
});

test("process identity verification rejects a reused PID identity", () => {
  const verification = verifyProcessIdentity(4242, "darwin:old birth identity", {
    platform: "darwin",
    runCommandImpl(command, args) {
      assert.equal(command, "ps");
      assert.deepEqual(args, ["-p", "4242", "-o", "lstart=", "-o", "comm="]);
      return {
        status: 0,
        signal: null,
        stdout: "Thu Jul 16 12:00:01 2026 /usr/bin/node\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(verification.verified, false);
  assert.equal(verification.reason, "identity-mismatch");
  assert.equal(verification.expectedIdentity, "darwin:old birth identity");
  assert.equal(
    verification.currentIdentity,
    "darwin:Thu Jul 16 12:00:01 2026 /usr/bin/node"
  );
});

test("stop refuses an active job without process identity and preserves it", () => {
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  const jobId = "run-no-process-identity";
  const pid = process.pid;
  const job = {
    id: jobId,
    kind: "task",
    kindLabel: "delegate",
    title: "Identity-less active run",
    workspaceRoot: repo,
    jobClass: "task",
    summary: "must remain active",
    status: "running",
    phase: "running",
    pid,
    bridgePid: pid,
    bridgeIdentity: null,
    agentPid: null,
    agentIdentity: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z"
  };

  const previousData = process.env.GROK_PI_DATA;
  process.env.GROK_PI_DATA = pluginDataDir;
  try {
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  } finally {
    if (previousData == null) delete process.env.GROK_PI_DATA;
    else process.env.GROK_PI_DATA = previousData;
  }

  const result = run(process.execPath, [BRIDGE, "stop", jobId, "--json"], {
    cwd: repo,
    env: { ...process.env, GROK_PI_DATA: pluginDataDir }
  });

  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stopFailed, true);
  assert.equal(payload.killAttempted, false);
  assert.equal(payload.killDelivered, false);
  assert.ok(payload.killVerification.some((entry) => entry.reason === "missing-stored-identity"));

  process.env.GROK_PI_DATA = pluginDataDir;
  try {
    const retained = listJobs(repo).find((entry) => entry.id === jobId);
    assert.ok(retained);
    assert.equal(retained.status, "running");
    assert.equal(retained.pid, pid);
    assert.equal(retained.bridgePid, pid);
  } finally {
    if (previousData == null) delete process.env.GROK_PI_DATA;
    else process.env.GROK_PI_DATA = previousData;
  }
});

test("state pruning retains every active job and trims terminal history only", () => {
  const workspace = makeTempDir();
  const activeJobs = Array.from({ length: 55 }, (_, index) => ({
    id: `active-${index}`,
    status: index % 2 === 0 ? "running" : "queued",
    pid: 10_000 + index,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString()
  }));
  const terminalJobs = Array.from({ length: 55 }, (_, index) => ({
    id: `terminal-${index}`,
    status: index % 2 === 0 ? "completed" : "failed",
    updatedAt: new Date(Date.UTC(2026, 0, 2, 0, index, 0)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 0, 2, 0, index, 0)).toISOString()
  }));

  saveState(workspace, {
    version: 1,
    config: {},
    jobs: [...activeJobs, ...terminalJobs]
  });

  const saved = loadState(workspace).jobs;
  const activeIds = new Set(saved.filter((job) => ["queued", "running"].includes(job.status)).map((job) => job.id));
  const terminalIds = new Set(saved.filter((job) => !["queued", "running"].includes(job.status)).map((job) => job.id));
  assert.equal(activeIds.size, 55);
  assert.deepEqual(activeIds, new Set(activeJobs.map((job) => job.id)));
  assert.equal(terminalIds.size, 50);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(terminalIds.has(`terminal-${index}`), false);
  }
  for (let index = 5; index < 55; index += 1) {
    assert.equal(terminalIds.has(`terminal-${index}`), true);
  }
});

test("hidden Pi custom messages are excluded from handoff", () => {
  const hidden = "HIDDEN_EXTENSION_CONTROL_MESSAGE";
  const visible = "visible user context";
  const handoff = buildPiTransferPrompt({
    header: { id: "pi-security-session", cwd: "/repo" },
    branch: [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: visible }] }
      },
      {
        type: "custom_message",
        id: "hidden-1",
        parentId: "user-1",
        customType: "extension-internal",
        display: false,
        content: [{ type: "text", text: hidden }]
      }
    ]
  });

  assert.match(handoff.prompt, new RegExp(visible));
  assert.doesNotMatch(handoff.prompt, new RegExp(hidden));
  assert.equal(handoff.messageSections, 1);
});

test("runHeadlessAgent terminates and bounds output above maxOutputBytes", { timeout: 5_000 }, async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const fakeGrok = path.join(binDir, "grok-output-flood");
  writeExecutable(fakeGrok, `#!/usr/bin/env node
process.stdout.write("X".repeat(64 * 1024));
setTimeout(() => process.exit(0), 2000);
`);

  const startedAt = Date.now();
  const result = await runHeadlessAgent(cwd, {
    binary: fakeGrok,
    prompt: "exercise output limit",
    maxOutputBytes: 1_024
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 1);
  assert.match(result.stderr, /output exceeded 1024 bytes/i);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 1_024);
  assert.ok(Buffer.byteLength(result.finalMessage, "utf8") <= 1_024);
  assert.ok(elapsedMs < 1_900, `expected flood process to be stopped early, took ${elapsedMs}ms`);
});

test("show pagination respects Pi line limits and UTF-8 byte boundaries", () => {
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  const shortLinesId = "run-short-lines-page";
  const multibyteId = "run-multibyte-page";
  const shortLinesOutput = Array.from({ length: 3_000 }, (_, index) => `行-${index}`).join("\n");
  const multibyteOutput = "你".repeat(30_000);
  const previousData = process.env.GROK_PI_DATA;
  process.env.GROK_PI_DATA = pluginDataDir;
  try {
    for (const [id, rawOutput] of [
      [shortLinesId, shortLinesOutput],
      [multibyteId, multibyteOutput]
    ]) {
      const job = {
        id,
        status: "completed",
        phase: "done",
        title: "Paged output",
        kind: "task",
        jobClass: "task",
        workspaceRoot: repo,
        result: { rawOutput },
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z"
      };
      writeJobFile(repo, id, job);
      upsertJob(repo, job);
    }
  } finally {
    if (previousData == null) delete process.env.GROK_PI_DATA;
    else process.env.GROK_PI_DATA = previousData;
  }

  const env = { ...process.env, GROK_PI_DATA: pluginDataDir };
  const first = run(process.execPath, [BRIDGE, "show", shortLinesId, "--json"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstPage = JSON.parse(first.stdout);
  assert.ok(firstPage.pagination.nextOffsetBytes > 0);
  assert.ok(firstPage.page.split("\n").length <= 1_801);

  let offset = 0;
  let combined = "";
  do {
    const result = run(
      process.execPath,
      [BRIDGE, "show", multibyteId, "--json", "--offset-bytes", String(offset)],
      { cwd: repo, env }
    );
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.doesNotMatch(page.page, /�/);
    combined += page.page;
    offset = page.pagination.nextOffsetBytes;
  } while (offset != null);

  assert.equal(combined, `${multibyteOutput}\n`);
});
