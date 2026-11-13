# Sharing one CodeBuddy backend across Raft agents

## Why

CodeBuddy is expensive to start and to keep resident. Running one
`codebuddy --serve --acp` process per Raft agent made a five-agent workspace
spawn five full coding agents at once, which produced a visible CPU/RSS spike
and, on a 2 GB machine, memory pressure and swap.

At the same time, Codex's runtime shows the opposite shape: a single
`codex app-server` process can host several threads, and Raft can start five
agents without five app-server processes. The reason is that Codex's protocol
is thread-first: every `turn/start` carries a `threadId`, and the app-server
routes results by that id.

## What we found in CodeBuddy

### Ordinary ACP clients are effectively single-current

With the code shown in this repository before this change, two connections or
two sessions on one CodeBuddy process did not work reliably:

- two connections with one session each, concurrent prompts: one answered, the
  other hung until timeout;
- one connection with two sessions: the last-created session answered first;
  prompting the earlier session hung and poisoned the connection;
- server logs showed both model calls completing, but only one prompt resolving:
  `[AcpView][PromptIterator] received prompt session=<the other session>` and
  `route=parkInQueue hasWaiter=false`. Only the current session reached
  `Prompt completed` and `sendToClient`.

So the old “CodeBuddy binds one live session per process” conclusion was
directionally right for ordinary ACP clients, but the mechanism was wrong: the
server accepts multiple connections and sessions, yet its ACP view only routes
one current session's prompt result correctly.

### Web UI clients are multi-session

CodeBuddy's Web UI client path is the multi-session path. Setting:

- `initialize.params.clientInfo.name = "codebuddy-web-ui"`
- `x-codebuddy-web-ui: 1` on every ACP HTTP request
- `x-codebuddy-request: 1` on every ACP HTTP request

makes one CodeBuddy process route several connections/sessions correctly.

Measured on CodeBuddy 2.182.0 (Linux, loopback, low-memory V8 flags):

| Scenario | Result |
| --- | --- |
| One process, 5 connections, 5 sessions, concurrent prompts | all 5 `end_turn`, correct per-session text, ~5.3 s |
| Same test with ordinary ACP client identity | some prompts time out |
| One process with 5 sessions, RSS | ~390 MB |
| Old shape: 5 separate ACP servers | roughly 5 × 300–360 MB |

Web UI mode also preserved the adapter surface we depend on:

- `session/set_config_option` for `model` and `thought_level`
- `session/load` with `_meta["codebuddy.ai/suppressReplay"] = true`
- `mode = fullAccess`
- concurrent `session/prompt`

The live adapter path was also verified with two real CodeBuddy agents sharing
one backend (one backend PID, both prompts answered, RSS ~387 MB), and
`npm run models:refresh` was verified against the shared backend (17 models).

## Design

```text
Raft agent A ── stdio ── adapter process A ─┐
Raft agent B ── stdio ── adapter process B ─┤  each adapter owns
Raft agent C ── stdio ── adapter process C ─┤  one ACP connection/session
Raft agent D ── stdio ── adapter process D ─┤
Raft agent E ── stdio ── adapter process E ─┘
                                      │
                                      ▼
                         http-daemon (one per host)
                                      │
                                      ▼
                    one CodeBuddy HTTP ACP server
```

### Components

- `src/http-daemon.mjs`: owns the only CodeBuddy server process. It listens on
  a Unix socket (named pipe on Windows), hands out the loopback endpoint to
  adapters, and stops the backend after the last adapter detaches plus a short
  grace period.
- `src/http-shared.mjs`: daemon discovery/launch, control-socket attach, state
  file, and `stopDaemon()` for tests/uninstall. `http-backend.json` stores the
  daemon PID as `pid` and the CodeBuddy PID as `backendPid`.
- `src/http-rpc.mjs`: a thin ACP-over-HTTP client. It no longer spawns a
  CodeBuddy process. It attaches to the daemon, opens its own connection, adds
  the Web UI headers, and detaches on close.
- `src/adapter.mjs`: keeps the Raft-facing ACP surface. It overrides the
  CodeBuddy initialize client name, uses the shared backend for the cold-cache
  probe, and reconnects/resumes on backend loss.
- `src/backends.mjs`: CodeBuddy resumes with history replay suppressed.
- `src/session-identity.mjs`: records the per-session `raft`/`slock`/`cont`
  wrapper and installs the dispatcher that the daemon puts in front of PATH.
- `src/cli-dispatcher.mjs`: reads `CODEBUDDY_SESSION_ID` from the tool process
  and execs the wrapper recorded for that session.

### Per-session Raft identity

The shared backend's process environment belongs to the first agent that
started it. Every Bash tool child inherits that agent's `PATH`,
`SLOCK_AGENT_ID` and proxy token, so a bare `raft message send` from any other
session used to post as the first agent.

CodeBuddy injects `CODEBUDDY_SESSION_ID` into tool children. The adapter uses
that id as the session key:

1. On `session/new` or `session/load`, the adapter writes
   `session-identities/<sessionId>` containing its own
   `SLOCK_CLI_TRANSPORT_DIR` (the per-agent wrapper directory).
2. The daemon prepends `bin/` to the backend's `PATH` and installs
   `raft`/`slock`/`cont` shims there.
3. A shim runs `src/cli-dispatcher.mjs`, which reads
   `CODEBUDDY_SESSION_ID`, looks up the recorded transport, and execs that
   agent's wrapper. The wrapper sets its own `SLOCK_AGENT_ID`, token file and
   transport before running the Raft CLI.
4. `session/delete`/`session/close` and adapter shutdown remove the mapping.

No per-agent backend is needed for identity: one CodeBuddy process can serve
several sessions while each session talks to Raft as its own agent.

### Lifecycle

1. The first adapter asks the daemon for an endpoint; the daemon starts
   CodeBuddy once and writes the state file.
2. Every adapter opens its own connection and session; Raft continues to see
   one ACP stdio peer per agent.
3. When an adapter has been idle for `RAFT_ADAPTER_HTTP_IDLE_MS` it closes its
   connection and detaches. The daemon stops the shared CodeBuddy process after
   the last client has been gone for a short grace period.
4. The next request starts a new daemon/backend and `session/load` restores the
   agent's session without replaying history.
5. If the shared backend dies, adapters drop their broken client and reattach on
   the next request instead of taking every Raft agent down.

## Risks and limits

- CodeBuddy's Web UI identity is an internal/undocumented behavior. Re-verify
  concurrent prompts, model/thinking selection, permissions, and
  `session/load` after every CodeBuddy upgrade.
- One shared process is a single point of failure. The daemon isolates adapter
  processes from its own crash, but a wedged backend still affects all agents
  until it is restarted.
- The daemon is a small extra Node process. The heavy process is still one
  CodeBuddy server; this change does not make CodeBuddy itself lighter.
- `CODEBUDDY_SESSION_ID` is the session key the dispatcher relies on. It is
  undocumented CodeBuddy behavior; re-verify it after every CodeBuddy upgrade.
  If it disappears, Raft CLI calls fail loudly instead of silently posting as
  the first agent.
- A shared CodeBuddy process still has one working directory. The adapter sends
  its own cwd on `session/new` and `session/load`, but CodeBuddy may still run
  tools in the process cwd; re-check workspace isolation after an upgrade.
- `RAFT_ADAPTER_HTTP=0` keeps the stdio fallback for debugging. It remains one
  backend process per adapter and does not use the shared daemon.
- The state file contains a loopback password. It is written with mode 0600 on
  Unix and must not be exposed beyond the local host.

## Verification

```sh
npm run check
npm test
```

The offline suite includes five-agent shared-backend concurrency, idle stop and
resume, permission forwarding, usage, and the existing Devin/dsh/CodeBuddy ACP
tests. Live verification (not part of `npm test`) was run manually against
CodeBuddy 2.182.0 and reported above.