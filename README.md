# engager-agent

`engager-agent` is the least-privilege local executor for Engager Candidates. It uses the user's own authenticated Claude Code or Codex subscription to triage candidate posts and propose comments or replies. Engager owns discovery, frozen work selection, validation, receipts, scheduling, and publishing safety; the local model performs bounded cognition only.

The 0.9 runner is intentionally **v2.1-only**. It never executes the retired v1 model/MCP loop. If the server has not enabled the leased runner protocol for the organization, it stays idle with `CONTRACT_UPGRADE_REQUIRED`.

## Security boundary

For every cognition cycle, the Node parent process:

1. heartbeats protocol, engine, and quota health;
2. claims one server-selected, single-lane work order;
3. reads the complete frozen context in exact server order;
4. maintains the work-order lease;
5. sends that context to a tool-less Claude or Codex process over stdin;
6. rejects malformed or out-of-scope model output;
7. asks Engager to validate draft lanes deterministically;
8. persists the exact idempotent submission before sending it;
9. trusts only item-level server receipts and the terminal completion response.

The cognition process receives no Engager credential, lease token, MCP server, filesystem tools, shell, web, browser, plugins, project rules, or arbitrary parent environment. OpenAI, Anthropic, GitHub, cloud, and workspace secrets are not inherited. LinkedIn text is explicitly marked as untrusted data.

A `0600` recovery journal preserves claimed lease authority and every completed cognition/submission step. Once model output is journaled, the runner replays the exact request with the same idempotency key and never infers success from prose. A host crash before model output is durably recorded can require a new provider session, which receives a new conservative local debit, but it still cannot duplicate a server mutation. Lease loss terminates the whole model process group and prevents late submission.

## Requirements

- Node.js 20 or newer.
- An Engager organization with Candidates and runner protocol v2.1 enabled.
- One supported, locally authenticated engine:
  - Claude Code `2.1.x` in safe mode, authenticated with `claude auth login`.
  - Codex CLI `0.135.x`, authenticated with `codex login`. Codex execution ignores user config and rules and fails closed if an uncertified capability remains enabled.

The runner is designed for subscription-backed local agents. Engager does not perform or meter the model generation in this path; the user's provider limits and terms still apply.

## Install and setup

```bash
npx engager-agent setup
# or
npm install --global engager-agent
engager-agent setup
```

Setup detects both engines, requires a verified authenticated choice, discovers the Engager endpoint, and opens a browser device-authorization flow. The resulting credential is bound to the stable runner identity and the fixed `runner:execute` profile. Protocol-2 delivery persists the temporary key and its ACK authority together, promotes it only after durable storage, and replays a lost ACK on the next setup run. There is no broad-key paste fallback, and the key is never registered in interactive Claude or Codex clients.

Configuration is organization-level—campaign choice and cadence stay server-side—and is saved at `~/.engager/agent.json` with mode `0600`. When the selected provider uses a non-default `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, setup persists only that one absolute config-directory path so launchd uses the same authenticated provider identity; unrelated environment variables and secrets are never copied. Setup can execute at most one proof claim. On macOS it offers background service installation only after an accepted proof receipt.

Use a separately authorized interactive-agent credential when you want Claude, ChatGPT, or Codex to configure Engager manually.

## Commands

```bash
engager-agent                         # status only; never starts work
engager-agent setup                   # guided setup
engager-agent setup --reauthorize     # mint a replacement runner credential
engager-agent doctor                  # read-only engine/server/service checks
engager-agent doctor --json
engager-agent run                     # foreground control loop
engager-agent run --once              # same claim/lease/receipt path, one claim maximum
engager-agent status [--json]
engager-agent logs [--tail 80]        # sanitized local logs
engager-agent pause [--for 2h]
engager-agent resume
engager-agent stop
engager-agent start
```

There is no local batch-size, campaign, discovery, or cadence override. An empty or failed claim performs no model work and never invents an offline fallback.

## Background service on macOS

```bash
engager-agent service install
engager-agent service repair
engager-agent service status
engager-agent service uninstall
```

Service installation copies the standalone CLI bundle into a hashed version directory under `~/.engager/runtime/versions`, verifies its SHA-256 and version, and writes launchd against the lexical `runtime/current/cli.mjs` path. Temporary `_npx`, cache, version-manager, and Codex-owned Node runtimes are refused. The launch milestone requires this exact service process to verify both current protocol 2.1 control and the configured engine's authentication/capability boundary. A failed launch proof restores both the previous runtime link and plist.

Linux supports foreground or external-scheduler execution. Windows execution fails closed in 0.9 because descendant-process termination is not yet certified; use macOS or Linux. Native service management is currently macOS-only.

Only one work-producing process may hold a runner identity locally. Foreground, service, setup proof, and `run --once` share the same atomic singleton lock.

## State and recovery

- `~/.engager/agent.json` — credential and org-level configuration (`0600`)
- `~/.engager/status.json` — atomic health/status snapshot
- `~/.engager/active-work.json` — exact leased recovery journal (`0600`)
- `~/.engager/locks/` — home-global singleton ownership (one credential/journal authority at a time)
- `~/.engager/logs/` — sanitized logs (`0700` directory, `0600` files)
- `~/.engager/runtime/` — verified versioned service payloads

Provider quota exhaustion and transient overload idle without triggering the generic permanent halt. Repeated contract, sandbox, or invalid-output failures halt loudly after three cycles. A server stop directive halts regardless of its reason code. Resume only after `engager-agent doctor` explains and clears the cause.

## Publishing and contract coordination

The runner uses `@engager/runner-contract` as executable schema code. A coordinated release may use either an exact registry version or the reviewed vendored archive declared in `package.json`; the vendored path is accepted only when its package identity, protocol version, SHA-256, SHA-512 lock integrity, and installed export all match.

Release order is strict:

1. update the reviewed contract version/archive/hash metadata whenever Engager's executable schema changes; the release gate also runs semantic security probes so an exact but obsolete archive stays blocked;
2. run typecheck, dependency audit, tests, and `release:pack`;
3. smoke-test and SHA-256 verify that one immutable tarball;
4. publish that exact tarball with lifecycle scripts disabled so it cannot rebuild after verification.

The shipped runner is one standalone bundle with zero runtime npm dependencies. `prepublishOnly` and `release:pack` both enforce the reviewed contract pin; the release workflow publishes only the tarball recorded in `release-artifact/manifest.json`.

## LinkedIn risk

Engager relies on unofficial LinkedIn access. That can violate LinkedIn's terms, and connected accounts can be restricted or lose reach. The runner cannot post directly: accepted proposals still go through Engager's server-side approval mode, kill switch, active hours, caps, pacing, sensitivity rules, and exactly-once publisher. Start in shadow/manual approval with low limits and treat engagement received—not draft fluency—as the meaningful outcome.
