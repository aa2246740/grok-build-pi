import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package declares a Pi extension and current Pi peer packages", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./extensions/grok-build.ts"]);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.equal(pkg.peerDependencies["@earendil-works/pi-ai"], ">=0.80.7");
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.80.7");
  assert.match(pkg.engines.node, /22\.19/);
  assert.equal(pkg.repository.url, "git+https://github.com/aa2246740/grok-build-pi.git");
  assert.equal(pkg.scripts.prepack, "npm run check");
});

test("extension registers the full command surface and model tool", () => {
  const source = fs.readFileSync(path.join(ROOT, "extensions", "grok-build.ts"), "utf8");
  for (const command of ["check", "review", "critique", "delegate", "handoff", "import", "runs", "show", "stop"]) {
    assert.match(source, new RegExp(`grok-build:${command}`));
  }
  assert.match(source, /name:\s*"grok_build"/);
  assert.match(source, /ctx\.ui\.confirm/);
  assert.match(source, /if \(!ctx\.hasUI\)/);
  assert.match(source, /event\.reason === "reload"/);
  assert.match(source, /GROK_PI_SESSION_ID/);
  assert.match(source, /GROK_PI_LEAF_ID/);
});

test("packaged runtime has no Claude-host environment dependency", () => {
  const files = [
    path.join(ROOT, "extensions", "grok-build.ts"),
    path.join(ROOT, "scripts", "grok-bridge.mjs"),
    ...fs.readdirSync(path.join(ROOT, "scripts", "lib")).map((name) => path.join(ROOT, "scripts", "lib", name))
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /CLAUDE_PLUGIN_|GROK_CC_|GROK_CC_SESSION_ID/, path.basename(file));
  }
});
