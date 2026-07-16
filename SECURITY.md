# Security Policy

## Supported versions

Security fixes are provided for the latest tagged release. Pre-release branches and older tags may not receive backports.

## Report a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/aa2246740/grok-build-pi/security/advisories/new). Do not open a public issue containing exploit details, credentials, repository content, transcripts, or Grok/Pi logs.

Include the affected version, operating system, Pi and Grok CLI versions, reproduction steps, impact, and a minimal redacted proof of concept. You should receive an acknowledgement within seven days.

## Security model

This package is a Pi extension and runs with the permissions of the user who starts Pi. Read-only review and critique invoke Grok with a read-only sandbox. Delegation with `--write` uses Grok's `--always-approve`, does not add the bridge's read-only sandbox, inherits the Pi process environment, and is not confined to the current repository. Only use write mode with trusted prompts, repositories, and local configuration.

Commands that review code or transfer a session send selected content to Grok/xAI. Inspect repositories and visible transcript/tool content for secrets before approving a transfer.
