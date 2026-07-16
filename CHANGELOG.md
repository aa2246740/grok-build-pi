# Changelog

All notable changes to this project are documented here.

## 0.1.1 - 2026-07-16

- Execute the bridge correctly when the installed package path contains a directory symlink, including macOS `/tmp` to `/private/tmp` installations.

## 0.1.0 - 2026-07-16

- Port all eight upstream Grok Build bridge command entry points to Pi.
- Add Pi-native `/grok-build:handoff` and the typed `grok_build` model tool.
- Add explicit external-context confirmation for model-initiated operations.
- Add Pi active-branch session transfer with private thinking removal.
- Add bounded output, private prompt files, state permissions, cancellation barriers, and process-identity checks.
- Support the Grok CLI 0.2.101 structured-output envelope.
- Keep read-only delegate and handoff runs on the Grok `explore` agent.
- Recognize delegate `--wait` as an execution-control flag without forwarding it to the task prompt.
