import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildPiTransferPrompt, readPiSession, resolvePiSessionPath } from "../scripts/lib/pi-session-transfer.mjs";
import { makeTempDir } from "./helpers.mjs";

function writeSession(entries) {
  const file = path.join(makeTempDir(), "session.jsonl");
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return file;
}

test("readPiSession follows parent ids to select only the active branch", () => {
  const file = writeSession([
    { type: "session", version: 3, id: "s1", cwd: "/repo" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "root" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "active" } },
    { type: "message", id: "fork", parentId: "u1", message: { role: "assistant", content: "other" } }
  ]);
  const session = readPiSession(file, { leafId: "a1" });
  assert.deepEqual(session.branch.map((entry) => entry.id), ["u1", "a1"]);
  assert.equal(session.resolvedLeaf, "a1");
});

test("readPiSession rejects an unknown requested leaf instead of transferring the wrong branch", () => {
  const file = writeSession([
    { type: "session", version: 3, id: "s1", cwd: "/repo" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "root" } }
  ]);
  assert.throws(() => readPiSession(file, { leafId: "missing" }), /leaf missing was not found/i);
});

test("buildPiTransferPrompt omits thinking and retains tool context", () => {
  const session = {
    header: { id: "s1", cwd: "/repo" },
    branch: [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "debug auth" }] } },
      { type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
        { type: "text", text: "The test fails in token parsing." }
      ] } },
      { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "1 failing" }] } }
    ]
  };
  const result = buildPiTransferPrompt(session);
  assert.match(result.prompt, /debug auth/);
  assert.match(result.prompt, /npm test/);
  assert.match(result.prompt, /1 failing/);
  assert.doesNotMatch(result.prompt, /secret reasoning/);
});

test("buildPiTransferPrompt keeps the newest sections when capped", () => {
  const branch = Array.from({ length: 12 }, (_, index) => ({
    type: "message",
    message: { role: "user", content: `message-${index}-${"x".repeat(500)}` }
  }));
  const result = buildPiTransferPrompt({ header: { id: "s1", cwd: "/repo" }, branch }, { maxChars: 4_000 });
  assert.equal(result.truncated, true);
  assert.match(result.prompt, /message-11/);
  assert.doesNotMatch(result.prompt, /message-0-/);
});

test("resolvePiSessionPath rejects non-Pi JSONL after resolution", () => {
  const file = path.join(makeTempDir(), "not-pi.txt");
  fs.writeFileSync(file, "hello", "utf8");
  assert.throws(() => resolvePiSessionPath(process.cwd(), { source: file }), /JSONL/);
});
