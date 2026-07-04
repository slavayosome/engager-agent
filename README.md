# engager-agent

Local autonomous runner for Engager **agent-led** campaigns. It keeps your
comment queue stocked without a human in the loop, on your own Claude plan:

- **Hourly no-LLM preflight** over the hosted Engager MCP (per-org API key):
  queue runway, candidate-pool health, pending incoming comments. Most wakes
  cost nothing and spawn nothing.
- When there's real headroom, it spawns **headless Claude Code** (`claude -p`)
  with the sha256-verified `engager-batch` skill in autonomous mode and a
  fully-resolved work order ("campaign 7, batch size 3, reply to ids 11, 12").
- Every session is **verified against server state** — a session that claims
  success while the queue didn't grow is failed and retried once, narrowed to
  batch size 1. Three consecutive failed cycles stop the loop loudly.

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

The wizard connects (MCP URL + API key with `feed:read` + `messages:write`),
detects `claude`, picks the drafting model, installs the skill, lets you pick
an agent-led campaign, and ends with a batch-size-1 dry-run session so the
whole chain is proven before you walk away.

## Run

```
engager-agent                # the loop (hourly ±5min jitter)
engager-agent --once         # one cycle, exit 0/1 (cron-friendly)
engager-agent --once --batch 1
engager-agent config         # re-run the wizard
```

Config: `~/.engager/agent.json` (0600). Logs: `~/.engager/logs/YYYY-MM-DD.log`.

## Safety

The runner adds cost guards only (`--max-turns`, daily session cap). Posting
safety is entirely server-side and unchanged: manual campaigns land drafts as
`proposed` for dashboard approval; auto campaigns schedule through the paced
publisher, which is still gated per-post by caps, active hours, the kill
switch, and exactly-once send.
