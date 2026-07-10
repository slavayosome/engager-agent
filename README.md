# engager-agent

Local autonomous runner for Engager **agent-led** campaigns. It keeps your
comment queue stocked without a human in the loop, on your own Claude plan:

- **No-LLM preflight** over the hosted Engager MCP (per-org API key):
  queue runway, candidate-pool health, pending incoming comments. Most wakes
  cost nothing and spawn nothing.
- When there's real headroom, it spawns **headless Claude Code** (`claude -p`)
  with the sha256-verified `engager-batch` skill in autonomous mode and a
  fully-resolved work order ("campaign 7, batch size 3, reply to ids 11, 12").
- On **discover** campaigns it runs as a **scout**: the server's work order asks
  it to score unranked candidates (`submit_candidate_ranking`) and draft only the
  posts you explicitly requested — never window-fill. The ranked pool is the
  product; you pick what to engage.
- Every session is **verified against server state** — a session that claims
  success while the queue didn't grow is failed and retried once, narrowed to
  batch size 1. Three consecutive failed cycles halt the loop loudly.
- It **follows server intent live**: every ~5 minutes it heartbeats
  `report_runner_status` and obeys the directive that comes back — pause the
  campaign or flip the kill switch in the dashboard and the runner idles within
  minutes; delete the campaign (or flip it to server-led) and it halts for good.

All state (candidate backlog, promo/web-facts ratios, runway, pacing) lives
server-side, so the runner is stateless and crash-safe: kill it anytime,
restart it anywhere.

## Install

```
npx engager-agent          # run without installing
npm install -g engager-agent
brew install slavayosome/engager/engager-agent
```

Requires Node ≥20 and the [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code)
on your machine (the wizard detects it).

## Setup

```
npx engager-agent
```

The wizard **fails fast if the `claude` CLI is missing** (a hard requirement —
sessions are headless Claude Code; no Codex/Gemini adapters yet), then
**detects where your Engager already lives** instead of asking for a URL:
existing entries in Claude Desktop / Claude Code configs (endpoint only — their
interactive credentials are never reused), a local dev server if one responds,
or the Engager Cloud default; manual URL entry stays as the escape hatch.

The wizard always uses **browser approval** for a dedicated unattended-runner
credential. The server, not the CLI, assigns its fixed `runner:execute` profile
and binds it to this machine's stable runner id. There is no broad-key or manual
paste fallback: an older server that cannot prove least privilege must be
upgraded first.

It never registers that credential in Claude Code or Claude Desktop. Headless
sessions receive it only through a temporary `0600` MCP config. The wizard
installs only the sha256-verified `engager-batch` runner skill, picks the model
and campaign, runs a batch-size-1 proof, and finally offers **always-on
autostart** (macOS launchd). Connect interactive Claude/ChatGPT separately with
an interactive-agent key from Engager Settings.

**No campaign yet?** Not a dead end: the wizard saves your connection,
then hands you off to the dashboard or a separately authorized interactive
agent to create one. Re-run `engager-agent` and it resumes where it left off.

Re-run setup later with `engager-agent config`. The legacy
`engager-agent register` command now refuses to expose runner credentials to
interactive clients.

## Run

```
engager-agent                # the loop (drafting hourly ±5min, control poll every 5min)
engager-agent --once         # one cycle, exit 0/1 (cron-friendly)
engager-agent --once --batch 1
engager-agent config         # re-run the wizard
```

Config: `~/.engager/agent.json` (0600). Logs: `~/.engager/logs/YYYY-MM-DD.log`.

## Always on (macOS)

```
engager-agent service install    # launchd LaunchAgent: runs at login, restarts on crash
engager-agent service uninstall
engager-agent stop               # stop AND disable (survives KeepAlive + next login)
engager-agent start              # re-enable + start
engager-agent pause --for 2h     # hold drafting without stopping the process
engager-agent resume             # clear pause/halt markers + restart the service
```

**Crash vs halt:** launchd restarts crashes (non-zero exits) but never a
deliberate halt — after 3 consecutive failed cycles or a server *stop*
directive the runner writes `~/.engager/halted.json`, exits cleanly, and stays
down until you run `engager-agent resume`. A broken runner is loud, never
silently restarted.

## Status

```
engager-agent status         # human-readable: state, last cycle, next wake, service
engager-agent status --json  # for scripts/agents
```

The loop also writes `~/.engager/status.json` atomically at every transition,
and heartbeats the same fields to the server — so any Claude session connected
to the hosted Engager MCP can answer "how's my runner doing?" via
`get_runner_status` (the engager-status skill reports it automatically).

## Safety

The runner adds cost guards (`--max-turns`, daily session cap) and uses a
server-enforced least-privilege credential that cannot manage campaigns,
billing, safety, setup, or direct posting. Posting safety remains server-side:
manual campaigns land drafts as
`proposed` for dashboard approval; auto campaigns schedule through the paced
publisher, which is still gated per-post by caps, active hours, the kill
switch, and exactly-once send.
