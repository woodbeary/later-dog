# Usage ledger

## Sub-features

- Append one row per settled turn to `<data>/usage/YYYY-MM.jsonl`: bot, model,
  engine, tokens, the cost with where it came from (`costSource: "reported"`
  from the engine, or `"estimated"` from list prices when the engine reports
  tokens but no price), and who asked.
- Book each turn to the sender of the message that started it, captured when
  the message was accepted. A message that queues behind someone else's turn,
  or is steered into it, or someone pressing Steer, does not re-book that
  turn; the queued message's own turn is booked to its sender. A guarded relay
  (the Slack worker) may name the person it acts for with `onBehalfOf`.
- Name the asker: the email a person signed in with, else their device label;
  this computer for loopback; the routine; or "bot to bot" for a peer hop.
- Read a period back grouped by bot, model, person, day or engine, and export
  one CSV line per turn. Owners only; a chat-only device gets 403.
- Keep message text out of the ledger.

## User path

Settings → Usage shows the live per-bot card, then **Included with later.dog**:
today's use of dictation, voice, chat, typing suggestions and auto-review, each
with what is left of its daily allowance, and a 30-day chart of the one picked.
Below it, **History**: pick a period, group it, switch between the chart and the
table, or **Export CSV**. Every chart has a table view.

On the owner's later.dog, Settings also has **Dashboard**: every install's
dictation, voice and chat by day with active users, the estimated spend per
provider, the top users by cost, and the grant set for each provider with how
much of it is spent. Grants are edited there. Other installs see only their own
usage and no Dashboard page. Both read the usage service through
`GET /api/included-usage`, `GET /api/owner-usage` and
`PUT /api/owner-usage/grants`, which answer `null` or 404 when this install has
no included key or is not the owner's.

## Driving it

```sh
pnpm exec vitest run --no-file-parallelism server/usage-ledger-api.test.ts server/usage-attribution.e2e.test.ts
```

The test launches a fresh `control-laterdog` fixture with the repository's fake
engine, creates a bot, sends one turn as the owner through the control surface
and one as a paired device with a label, waits for both to settle, then checks
the month file has exactly two rows with the right triggers and no message
text, that `GET /api/usage` groups them by person and by bot with the fake
engine's `0.01` per turn, that `GET /api/usage.csv` returns three lines, and
that a client-scoped device is refused. It prints the fixture's server log
path as evidence and removes its temporary home.

`server/usage-attribution.e2e.test.ts` boots the server against the fake Claude, ACP
and Codex engines in a disposable home and reads the month file back: an ACP
turn on `grok-4.7` is booked at xAI's list price and marked estimated while an
unlisted model stays unpriced; a paired person's queued message, a live steer
and a queue Steer leave the owner's running turn booked to the owner, while
the queued message's own turn (1:1 and in a room) is the person's; and a
guarded send with `onBehalfOf` is booked to that person, one without it to
this machine, and a chat-only device cannot reach the route at all. It also
sends two turns to a Claude bot whose fake CLI restores the session's running
cost on `--resume` (`FAKE_CLAUDE_COST_STATE`), the way the real CLI does: the
second turn's result says 0.02, and both rows must still read 0.01.

For the same by hand:

```sh
node --experimental-strip-types scripts/control-laterdog.ts launch
pnpm control:laterdog new-bot --name Probe --url http://127.0.0.1:PORT
pnpm control:laterdog send --bot BOT_ID --text "hello" --url http://127.0.0.1:PORT
pnpm control:laterdog wait --bot BOT_ID --timeout 30 --url http://127.0.0.1:PORT
cat DATA_DIR/usage/$(date -u +%Y-%m).jsonl
```

Then open the printed preview, go to Settings → Usage → History, and confirm
the turn appears under **Bot** and under **Person** as "This computer".

## Unit regressions

```sh
pnpm exec vitest run server/usage-ledger.test.ts src/components/UsageHistory.test.ts server/request-auth.test.ts
pnpm exec vitest run server/routes/included-usage.test.ts src/lib/included-usage.test.ts src/components/UsageSection.test.ts src/components/OwnerDashboard.test.ts src/components/SettingsModal.pages.test.ts
```

These cover month files and 0600 modes, torn lines, clamped tokens, a blocked
directory never failing the turn, range parsing, every grouping, spreadsheet
formula neutralisation in the CSV, the localized person labels, and the admin
scope on both routes. The second line covers the usage service's answers being
checked and cached, grants validated before they are sent, the included tiles
and their table, the owner-only Dashboard page, and the grant editor's request.

## Gotchas

- Rows are appended when `turn.completed` folds. A turn that fails before it
  settles leaves no row, so a failed turn is not billed.
- The cost column is what the engine reported (real on a metered key, an
  equivalent on a subscription) or, for engines that report none, an estimate
  from `server/model-prices.ts`, marked `~` in History and People and labelled
  in the CSV's `cost_source` column. A model with no known price stays
  unpriced; the summary counts those turns separately instead of treating them
  as free.
- Claude's `total_cost_usd` is a running total, not a turn's figure: it grows
  across the turns of one CLI process and, on `--resume`, starts from a cost
  the CLI restored. The driver books each turn's growth. For a resumed
  process it finds the restored state among the session's recent results in
  `<data>/claude-cost-history.json`; without one, that first turn keeps its
  whole figure.
- The renderer's History card is not driven headlessly here; the fixture
  proves the server side and the table renders from a fixture in its unit test.
