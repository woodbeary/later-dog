# A failed turn in plain words, November 13

## What a person reads

When a turn fails, the row says what happened in the person's words and, where
there is something to do, what. The engine's own text is kept under **Details**.
One function, `plainFailure` in `shared/plain-failure.ts`, turns the raw cause into
the sentence; `failedTurnTool` in `shared/failed-turn.ts` writes it.

| Raw shape (from the drivers and the server) | What the person reads |
| --- | --- |
| `claude exited <code> before result[: <error tail>]`, `codex exited <code> [(signal X)] before turn/completed…`, `<engine> ACP exited <code or signal>.`, `pi turn failed`, `turn failed` | Scout stopped before it finished. |
| `Claude began a steered message but went silent; the turn was closed.` | Scout went quiet after your new message, so the turn was stopped. |
| `no activity for N minutes — the turn was stopped` | Scout showed no progress for N minutes, so the turn was stopped. |
| `` `cli` isn't installed, or isn't on this app's PATH `` | Scout could not start because a program it needs is missing on this computer. |
| `` `cli` isn't executable — … `` | Scout could not start because a program it needs is not allowed to run on this computer. |
| `` `cli` received too much launch data … `` | Scout could not start because the request was too large. Try a shorter message. |
| `spawn failed: …` | Scout could not start. Try again. |
| `<engine> initialization timed out …` | Scout did not start in time. Try again. |
| any other `… timed out` (not an automatic review) | Scout did not get an answer in time. Try again. |
| `could not deliver approval to the provider; …` | Your answer did not reach Scout. Try the task again. |
| `queued [channel ]message could not start — …` | Your waiting message could not start. Send it again. |
| `Could not carry on with <account>: …` | Could not carry on with <account>. Try again. |
| `Could not continue on <account>: …` | Could not continue on <account>. Try again. |
| `MCP server could not start…` / `exited…` / `startup timed out` / `request timed out…` | A connected tool could not start. Check its settings. / stopped before the turn ended. / did not start in time. Try again. / did not answer in time, so it is not clear whether it finished. |
| `<engine> did not shut down after it was asked to stop.` | Scout did not stop when asked, so some of its work may still be running. |
| `<label> HTTP 5xx…`, `503 Service Unavailable` | The service behind Scout's account had a problem. Try again. |
| a JSON body with a message | the message, as before |
| anything else | unchanged |

Scout is the dog's name; when the server does not know it, the row says "Your
dog". Sign-in rows (`setup`), the update prompt (`claudeUpdate`), usage limits
(`quota`), place failures (`place`), provider safety blocks, the Mac permission
message and the lines the stall watch and restart pickup write keep their words.

What stopped with the turn is said by kind, and only when something was
running (`server/laterdog/helpers-stopped.ts`): "A helper stopped when this turn
ended.", "2 helpers stopped …", "A command running in the background stopped
when this turn ended.", or both together. Older rows reading "The helpers
stopped with this turn." read "Work running in the background stopped when
this turn ended."

## On the wire

A failure row's `tool` is `{ name: "error: <plain sentence>", ok: false,
detail?: "<raw cause>" , …flags }`. `detail` is present only when the sentence
differs from the raw cause; it is capped at 1,200 characters and passed
through `redactSecretsInText` (`shared/redact.ts`), so no token-shaped string
reaches it. Older apps read only `name` and keep working.

## One line when the dog recovers by itself

When a recovery row (`tool.name` starting `recovery:`, `ok: true`, `tool.pickup`
`"watch"` or `"restart"`) follows a turn's failure rows, the desktop shows the
recovery line only, with a **Details** button that opens the failure rows under
it. `foldExchanges` in `src/lib/quiet-lines.ts` does this as a `recovered`
item; it walks back over the failure rows and hidden rows (digests, hidden tool
calls) and stops at anything else shown (the person's message, the dog's
words). Failure rows with their own treatment (`quota`, `place`) and the watch's
or pickup's own failure rows (`pickup` set, `ok: false`) are never folded, so
a recovery that fails shows as usual. Stored messages do not change.

## What the phone must read to show the same

- Failure row: show `tool.name` after `error:` as the line; when `tool.detail`
  is a string, put it under a Details disclosure.
- Recovered turn: a message with `kind: "activity"`, `tool.ok === true`,
  `tool.pickup` of `"watch"` or `"restart"` and `tool.name` starting
  `recovery:`. Hide the failure rows before it (`kind: "activity"`,
  `tool.ok === false`, `tool.name` starting `error:`, no `tool.pickup`,
  `tool.quota` or `tool.place`), walking back past digests and hidden tool
  rows and stopping at the person's message or any shown row; offer them
  behind Details on the recovery line.

## How it was proven

Unit tests:

```sh
pnpm exec vitest run shared/plain-failure.test.ts shared/failed-turn.test.ts \
  server/laterdog/helpers-stopped.test.ts server/drivers/claude-tasks.test.ts \
  src/lib/recovered-fold.test.ts src/lib/quiet-lines.test.ts
```

`shared/plain-failure.test.ts` holds the table above with samples taken from
the drivers' message templates, including the line seen live on November 13,
and checks that `detail` never carries a token. `src/lib/recovered-fold.test.ts`
checks failure plus recovery gives one visible row and a failure alone stays
the failure.

Fixture run in the real renderer, headless (recipe in [Chat UI](chat-ui.md)),
with the fake engine failing its first three launches with a 503:

```sh
FAKE_CLAUDE_TRANSIENTS=3 FAKE_CLAUDE_STATE=/path/to/state \
  node --experimental-strip-types scripts/control-laterdog.ts ui launch
```

Send one message to Pepper. The driver retries twice and the turn fails; the
stall watch carries it on after its default three quiet minutes, and the fourth
launch answers.

| Moment | Stored row | What the screen showed |
| --- | --- | --- |
| After the turn failed | `name: "error: Pepper stopped before it finished."`, `detail: "claude exited 5 before result: claude: API error (503): service temporarily unavailable"` | One row, "Pepper stopped before it finished.", with Details (closed) and Retry; opening Details shows the raw line. |
| After the watch carried on | the failure row, then `recovery: Pepper stopped before finishing, so it is carrying on by itself.` with `pickup: "watch"`, then the answer | One recovery line with a Details button, then the answer; no failure row on screen (`[data-turn-error]` count 0). Details opens the failure row, and its own Details the raw line. |

The browser console had no errors. `server/laterdog/stall-watch.e2e.test.ts`
("an engine that exits mid-turn …") also checks that a killed engine leaves
`error: Exit dog stopped before it finished.` with the `claude exited …` line in
`detail`.

## Not proven

- No real engine was made to die with this code; the sentences were checked
  against the drivers' templates, the fake engine and the line seen live.
- A restart pickup folding its turn's failures is proven by unit tests only.
- The helpers sentence by kind is proven by unit tests and the fake engine's
  helpers; a real background command stopping was not rerun.
- The chat header and sidebar still say "Stopped: the engine reported an error"
  while the dog is stopped; that line comes from the work state, not this row.
- The phone does not read `detail` or fold recoveries yet.
