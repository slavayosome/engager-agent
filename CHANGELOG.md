# Changelog

## 0.9.1 — 2026-07-17

- Triage matches can now carry an `angle` (≤280 chars): the user's one-line
  contribution angle for the post, rendered as "Your angle" on the Radar
  detail pane. Vendored runner contract updated to 1.2.0 (additive; the
  server tolerantly clamps or drops malformed angles — a bad angle never
  fails a verdict).
- The runner's own daily session budget now reports as `LOCAL_SESSION_CAP`
  instead of masquerading as `ENGINE_QUOTA`, with cause-specific recovery
  (raise `dailySessionCap` or wait for the UTC-midnight reset; manual runs
  still work). The server renders it as "Daily agent budget used".
- `engager-agent status` warns when the background service is still running
  an older durable payload than the installed CLI (run `engager-agent
  upgrade` to refresh), and reports the active payload version in
  `status --json`.
- README gains an Upgrading section.

## 0.9.0 — 2026-07-15

- Runner protocol 2.1 execute-only client: leased work orders, exact
  receipts, least-privilege runner credential, durable service payload,
  disconnect flow. (See repository history for the full phase-4 series.)
