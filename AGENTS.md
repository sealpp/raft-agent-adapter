# AGENTS.md

Guidance for coding agents working in this repository.

## Setup

A condensed runbook for an agent asked to install and configure this adapter from a checkout of this repository.

An agent can install, select a backend, refresh the model catalog, and run the offline checks. It cannot sign in to a backend CLI — all three sign-ins are interactive — and cannot drive the Raft UI. Escalate those to the user instead of retrying.

1. Prerequisites: `node --version` ≥ 22 and `git` on PATH. Confirm one authenticated backend: `devin`, `dsh`, or `codebuddy` on PATH, or Devin at its standard install path (`%LOCALAPPDATA%\devin\cli\bin\devin.exe` on Windows, `~/.local/bin/devin` on Linux/macOS). If the backend is not signed in, ask the user to run `devin setup`, `dsh web`, or `codebuddy`. For CodeBuddy, `CODEBUDDY_API_KEY` in the environment that starts Raft is a non-interactive alternative.
2. Backend: copy `adapter.config.example.json` to `adapter.config.json` and set `"backend"` to `devin`, `dsh`, or `codebuddy` — or export `RAFT_ADAPTER_BACKEND`. `auto` resolves to Devin when its CLI is found, else dsh; it never selects CodeBuddy.
3. Install and verify (no `npm install` needed — the adapter has no runtime dependencies):

   ```sh
   platform/linux/install.sh              # optional: --devin-exe PATH --proxy-url URL
   npm run models:refresh                 # reads models + thinking options; no inference prompt
   platform/linux/test-adapter.sh         # ACP handshake + model discovery via the built launcher
   npm run check && npm test              # fully offline protocol suite
   ```

   On Windows: `.\platform\windows\Install.ps1 [-DevinExe ...] [-ProxyUrl ...]`, `Refresh-Models.ps1`, `Test-Adapter.ps1`. Do not run `--live` or `npm run test:live` unless the user asked — they exercise the real account.
4. Hand back: the remaining steps are Raft UI work for the user — add an internal agent → Grok Build → refresh the model list → pick a `Devin · …` / `DSH · …` / `CodeBuddy · …` model. If Grok Build is absent from the runtime inventory, rescan runtimes or restart the Computer.

Failures: `Another grok exists` means another checkout owns the slot — run its `uninstall.sh` / `Uninstall.ps1` first. `Authentication required` means the backend is not signed in — escalate to the user. No backend-prefixed models in Raft → rerun `models:refresh`, then rescan runtimes.

## Layout

- `src/`: the ACP adapter (`adapter.mjs`, `backends.mjs`, `model-config.mjs`, `config.mjs`, `rpc.mjs`, `http-rpc.mjs`, `http-shared.mjs`, `http-daemon.mjs`). For CodeBuddy, `http-daemon.mjs` owns one shared loopback HTTP ACP server and every adapter process attaches its own connection/session through CodeBuddy's Web UI client path; `RAFT_ADAPTER_HTTP=0` falls back to stdio, and `RAFT_ADAPTER_HTTP_IDLE_MS` (default 300000) detaches idle adapters and stops the shared backend after the last client.
- `test/`: offline protocol tests against deterministic fake peers.
- `scripts/`: model catalog refresh, live smoke test, and fake-peer configuration.
- `platform/`: Windows and Linux launchers, install, uninstall, and test scripts.
- `docker/`: Linux verification image and ACP probe.
- `me_raft-agent-adapter/`: maintains internal documentation, design notes, and research tools.

## Verification

- `npm test`: offline suite. It needs no Devin login and sends no inference prompts.
- `npm run check`: syntax check of the adapter modules.
- `npm run models:refresh`: rebuilds the local model catalog from a logged-in Devin CLI. It sends no inference prompts.
- `npm run test:live`: live checks against a logged-in Devin CLI. Run these manually.

## Diagnostics

Read-only diagnostics cover the Devin ACP session surface:

- Model and configuration probes: model lists, thinking levels, and speed options for each model.
- Catalog consistency: comparing the local model catalog with live ACP responses.
- Mapping checks: confirming that a reasoning or speed choice applies and reads back on a session.

They open sessions and change session configuration only. They never send prompts.

## Conventions

- Use Conventional Commits (`feat`, `fix`, `docs`, `ci`, `chore`, and so on).
- Do not commit generated or account-specific files: `.local/`, `bin/`, `adapter.config.json`, `model-catalog.json`, or captured account data.
- Keep public documentation consistent with the Devin CLI version used for verification.