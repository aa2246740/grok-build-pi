# Grok Build for Pi

A Pi coding-agent extension that bridges to the real Grok Build CLI for code review, design critique, task delegation, background runs, and session handoff.

This is an independent Pi port of [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc), based on upstream commit `5a9f924a8d1ca802b3e6dc0ce0e1a602fb35ec9e`. It is not an official xAI release.

## Upstream compatibility

The port covers all eight upstream command entry points and adds `/grok-build:handoff` plus the typed `grok_build` Pi tool. It preserves the core review, critique, delegation, background-run, result, stop, and session-transfer goals, but it is a Pi-native port rather than a byte-for-byte host emulation:

- delegation is read-only unless the user explicitly passes `--write`;
- Pi handoff exports the active Pi conversation branch instead of invoking Claude Code's raw `grok import` path;
- Pi lifecycle, confirmation, output paging, state permissions, and process-identity checks replace the corresponding Claude Code hooks and agent policy.

## Requirements

- Pi `0.80.7` or later using the current `@earendil-works/pi-*` package scope
- Node.js `>= 22.19.0`
- Grok Build CLI (`grok`) on `PATH`, or `GROK_BINARY` set to its path
- An authenticated Grok CLI session (`grok models` succeeds), or supported xAI credentials

The initial release was exercised with Pi `0.80.7`, Node.js `24.6.0`, and Grok Build CLI `0.2.101`.

The extension never reads Pi provider credentials from `modelRegistry`; Grok authentication remains owned by the Grok CLI.

## Try or install locally

From this directory:

```bash
# One session only
pi --no-extensions -e .

# Install for the current user
pi install "$(pwd)"

# Install for only the current project
pi install "$(pwd)" -l
```

For a repository whose root is this package:

```bash
pi install git:github.com/aa2246740/grok-build-pi@v0.1.0
```

Pi packages execute with the user's system permissions. Review the source before installing.

## Commands

### `/grok-build:check`

Checks Node, the Grok CLI, and Grok authentication.

### `/grok-build:review`

Runs a read-only code review against the working tree or a branch diff.

```text
/grok-build:review --wait
/grok-build:review --background --scope working-tree
/grok-build:review --base main --model grok-build --effort high
```

### `/grok-build:critique`

Challenges the implementation approach, assumptions, and design tradeoffs. It uses the same target selection as review and requests structured output.

```text
/grok-build:critique --wait
/grok-build:critique --base main focus on retry and caching failure modes
```

### `/grok-build:delegate`

Delegates an investigation or task to Grok. Delegation is read-only by default.

```text
/grok-build:delegate investigate the flaky auth test
/grok-build:delegate --resume apply the next diagnostic step
/grok-build:delegate --background investigate the regression
/grok-build:delegate --write implement the agreed fix
```

`--write` is an explicit opt-in. It maps to Grok's `--always-approve` and disables the bridge's read-only sandbox. The Grok child inherits the Pi process environment and the user's OS permissions, so write mode is not confined to the repository. Do not use it for an untrusted prompt or repository.

### `/grok-build:handoff`

Transfers the active branch of the current persisted Pi session into a new, resumable Grok thread.

```text
/grok-build:handoff
/grok-build:handoff --max-chars 100000 --model grok-build --effort high
```

`/grok-build:import` remains as a compatibility alias. This is deliberately not a raw `grok import`: the Grok CLI officially imports Claude Code sessions, while Pi uses a different v3 tree JSONL format. The port instead:

- follows Pi parent IDs to export only the active branch;
- excludes all private `thinking` blocks;
- includes visible user/assistant text, tool calls/results, visible extension messages, and compaction summaries;
- keeps the newest context when the default 160,000-character limit is exceeded;
- starts a one-turn, read-only Grok handoff and returns a resumable Grok session ID.

Invoking the slash command is the user's transfer request. When the Pi model calls the `grok_build` tool's transfer action, the extension requires an interactive confirmation.

### `/grok-build:runs`, `/grok-build:show`, `/grok-build:stop`

```text
/grok-build:runs
/grok-build:runs <run-id> --wait
/grok-build:show <run-id>
/grok-build:show <run-id> --offset-bytes 40000
/grok-build:stop <run-id>
```

`show` returns bounded 40 KB pages and prints the next byte offset when more output is available.

Background work retains the upstream detached worker and separate bridge/agent tracking. Stop operations verify OS process birth identities, install an atomic cancellation barrier, terminate the supervisor before the detached agent, and only then record the run as cancelled. If identity or termination cannot be verified, the active record is preserved for a safe retry.

## Pi model tool

The package registers one model-callable tool, `grok_build`, with these actions:

- `check`
- `review`
- `critique`
- `delegate`
- `transfer`
- `runs`
- `show`
- `stop`

The tool's system guidance restricts use to cases where the user explicitly asked to involve Grok Build/xAI. In addition, every model-tool action that sends repository or session context externally requires an interactive confirmation; such actions are rejected in headless mode. Review and critique are hard-coded read-only. A write-capable delegate requires `write=true`, with the same confirmation warning that Grok receives the user's OS permissions and is not confined by the bridge's read-only sandbox. Explicit slash commands are treated as direct user requests.

## Security and data handling

- Review and critique send selected Git context to Grok/xAI. The collector can include diffs and bounded small untracked text files; symbolic links, non-regular files, repository escapes, and aggregate overflow are skipped. Inspect the working tree for secrets before running either command.
- Session handoff sends transcript context to Grok/xAI. Private thinking is removed, but visible tool arguments and tool results can still contain sensitive data.
- State is stored under Pi's agent directory at `extensions/grok-build-pi/state`, separated by workspace. Directories are mode `0700`; state and log files are mode `0600` where the platform supports POSIX permissions.
- A Pi hot reload does not stop detached work. On session shutdown, jobs are cancelled and removed only when every persisted process identity can be verified and stopped; unverifiable active records remain available for manual inspection or retry.
- Headless Grok runs pass `--no-auto-update`, so an extension operation does not update the Grok CLI as a side effect.
- Prompts and handoff transcripts are passed through private `0600` temporary files instead of process arguments and are deleted when Grok exits.
- Grok stdout/stderr capture is capped at 16 MB per run. Tool and command output inserted into Pi context is further bounded to Pi's standard 50 KB / 2,000-line limits. Full tracked output is available in bounded pages through `/grok-build:show`.
- The bridge and Grok child inherit the environment of the Pi process. Keep unrelated secrets out of Pi's environment, particularly before using write mode.
- Stored jobs can contain prompts, results, and logs. Remove the extension state directory under Pi's agent directory when those records are no longer needed.
- Report security issues privately as described in [SECURITY.md](SECURITY.md), rather than opening a public issue with exploit details or sensitive logs.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Override the `grok` executable |
| `GROK_NODE_BINARY` | Override the `node` executable used by the Pi adapter |
| `GROK_PI_DATA` | Bridge state root; normally injected by the extension |
| `GROK_PI_SESSION_ID` | Pi session identity; normally injected by the extension |
| `GROK_PI_TRANSCRIPT_PATH` | Current Pi JSONL transcript; normally injected by the extension |
| `GROK_PI_LEAF_ID` | Active Pi tree leaf; normally injected by the extension |

## Development

```bash
npm ci
npm run check
```

The test suite uses Node's built-in test runner and a fake Grok executable. A real Pi smoke test can be run without calling a model:

```bash
printf '%s\n' '{"id":"commands","type":"get_commands"}' \
  | pi --no-extensions -e . --mode rpc --offline --no-session
```

## License and attribution

Apache-2.0. See `LICENSE` and `NOTICE`. The bridge runtime derives from xAI's Apache-2.0 Grok Build Claude Code plugin; the Pi adapter and Pi session-transfer layer are modifications described in `NOTICE`.
