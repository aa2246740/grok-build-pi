// Modified from xAI's Grok Build bridge test suite for the Pi port (2026).
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  buildReviewPrompt,
  getGrokAuthStatus,
  getGrokAvailability,
  parseStructuredOutput,
  resolveGrokBinary,
  runHeadlessAgent
} from "../scripts/lib/grok.mjs";
import { runCommand } from "../scripts/lib/process.mjs";

test("resolveGrokBinary prefers GROK_BINARY override", () => {
  assert.equal(resolveGrokBinary({ GROK_BINARY: "/custom/grok" }), "/custom/grok");
  assert.equal(resolveGrokBinary({}), "grok");
});

test("getGrokAvailability reports available with fake grok on PATH", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const status = getGrokAvailability(process.cwd(), { env });
  assert.equal(status.available, true);
  assert.match(status.detail, /0\.2\.83-fake|ok/i);
});

test("getGrokAuthStatus uses models probe success as logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.source, "models-probe");
});

test("getGrokAuthStatus treats failed models as not logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "not-logged-in");
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, false);
  assert.match(auth.detail, /Not logged in|not logged in|failed/i);
});

test("runHeadlessAgent captures stdout and session id from fake grok", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "check the thing",
    env,
    permissionMode: "plan",
    sandbox: "read-only"
  });

  assert.equal(result.status, 0);
  assert.match(result.finalMessage, /Handled the requested task/);
  assert.equal(typeof result.threadId, "string");
  assert.ok(result.threadId.length > 0);
  assert.ok(result.args.includes("--prompt-file"));
  const promptPath = result.args[result.args.indexOf("--prompt-file") + 1];
  assert.equal(fs.existsSync(promptPath), false);
  assert.ok(result.args.includes("--no-auto-update"));
  assert.ok(result.args.includes("--permission-mode"));
  assert.ok(result.args.includes("plan"));
});

test("runHeadlessAgent forwards max turns for bounded handoff runs", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const result = await runHeadlessAgent(makeTempDir(), {
    prompt: "handoff",
    env: buildEnv(binDir),
    maxTurns: 1
  });
  assert.equal(result.status, 0);
  assert.equal(result.args[result.args.indexOf("--max-turns") + 1], "1");
});

test("parseStructuredOutput extracts fenced JSON", () => {
  const raw = 'Here you go:\n```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```\n';
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput unwraps the Grok CLI headless JSON envelope", () => {
  const review = {
    verdict: "needs-attention",
    summary: "Failure semantics need work.",
    findings: [],
    next_steps: ["Surface the final error."]
  };
  const raw = JSON.stringify({
    text: JSON.stringify(review),
    stopReason: "EndTurn",
    sessionId: "a07cb374-7341-40a3-85f4-becb2262e773",
    structuredOutput: review
  });

  const parsed = parseStructuredOutput(raw);

  assert.equal(parsed.parseError, null);
  assert.deepEqual(parsed.parsed, review);
  assert.equal(parsed.rawOutput, raw);
});

test("parseStructuredOutput does not let fallback clobber canonical fields", () => {
  const parsed = parseStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}', {
    parsed: { verdict: "needs-attention" },
    parseError: "stale",
    rawOutput: "stale",
    status: 7
  });
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.status, 7);
});

test("runHeadlessAgent reports agentPid from the spawned child", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();
  const progressEvents = [];

  const result = await runHeadlessAgent(cwd, {
    prompt: "pid check",
    env,
    onProgress: (event) => progressEvents.push(event)
  });

  assert.equal(typeof result.agentPid, "number");
  assert.ok(result.agentPid > 0);
  assert.ok(progressEvents.some((event) => event?.agentPid === result.agentPid));
  assert.equal(typeof result.agentIdentity, "string");
});

test("buildReviewPrompt includes target and focus", () => {
  const prompt = buildReviewPrompt({
    targetLabel: "working tree diff",
    focusText: "auth boundaries",
    collectionGuidance: "Use the repository context below as primary evidence.",
    reviewInput: "## Git Status\n M app.js"
  });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /auth boundaries/);
  assert.match(prompt, /Git Status/);
});

test("live grok --help advertises headless flags when grok is on PATH", () => {
  const help = runCommand("grok", ["--help"], { cwd: process.cwd() });
  if (help.error?.code === "ENOENT" || help.status !== 0) {
    // Optional smoke only when a real grok binary is available.
    return;
  }
  const text = `${help.stdout}\n${help.stderr}`;
  for (const flag of [
    "-p",
    "--single",
    "-r",
    "--resume",
    "--session-id",
    "--always-approve",
    "--agent",
    "--permission-mode",
    "--sandbox",
    "--output-format",
    "--json-schema",
    "--effort"
  ]) {
    assert.match(text, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
