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
| `HTTP 5xx…`, `503 Service Unavailable`, `API Error: 529 Overloaded…` | The service behind Scout's account is busy or briefly unavailable. Try again in a moment. |
| a JSON body with a message | the message, as before |
| anything else | unchanged |

When the engine's error tail, or the text after the colon or dash, gives a reason the
app already knows, the sentence says that reason instead of the generic one, in the
words used elsewhere in the app:

| Reason in the raw text | Exit or time-out | Waiting message | Carry on / continue on X |
| --- | --- | --- | --- |
| not logged in, `/login`, invalid key, 401, expired or unrefreshable token, "needs … sign in" | Scout stopped because its account needs you to sign in again. | Your waiting message could not start: Scout's account needs you to sign in again. | Could not carry on with X: it needs you to sign in again. |
| usage limit, out of usage, resting (with "until/at/resets <time>" when given) | Scout stopped because its account is out of usage until 5pm. (or "for now") | …: Scout's account is out of usage until 5pm. | …: it is out of usage for now. |
| "<account> is turned off" | Scout stopped because its account is turned off. Turn it back on or pick another account. | same | …: it is turned off. Turn it back on or pick another account. |
| no space left, disk full, insufficient disk space | Scout stopped (or could not start) because this computer is almost out of space. Free up some space and try again. | same | same |
| 5xx, overloaded, rate limit | Scout stopped because the service behind its account is busy or briefly unavailable. Try again in a moment. | same | same |

A sign-in reason also sets `setup` on the row, so the desktop shows the sign-in
button it shows for every other sign-in row. A usage-limit reason is said in
words only: the row does not get `quota`, because the time is not known in a
form the limit row reads. Raw text containing "sign in to Claude", "sign in to
ChatGPT", "sign in to Grok" or "sign in to Cursor" is kept word for word, because
the phone matches that phrase in `name` to show its accounts button.

Scout is the dog's name; when the server does not know it, the row says "Your
dog". Sign-in rows (`setup`), the update prompt (`claudeUpdate`), usage limits
(`quota`), place failures (`place`), provider safety blocks, the Mac permission
message and the lines the stall watch and restart pickup write keep their words.

An engine's API error that arrives as a reply (the Claude engine's
`is_api_error_message` frame, for example "API Error: 529 Overloaded. …") is now a
failure row like the others, with Retry and the raw line under Details, and no
reply bubble from the dog.

What stopped with the turn is said by kind, and only when something was
running (`server/laterdog/helpers-stopped.ts`): "A helper stopped when this turn
ended.", "2 helpers stopped …", "A command running in the background stopped
when this turn ended.", or both together. Stored rows are never rewritten, so
older rows still read "The helpers stopped with this turn."

## Decisions read the raw cause

The sentence is only what the person reads. Code that decides something from a
failure row reads `tool.detail`, or the text after `error:` on rows without it:

- the stall watch (`failureOf` in `server/laterdog/stall-watch.ts`): turned off,
  sign-in, permission and never-retry are tested on the raw cause, never on the
  sentence or the dog's name; a sign-in, permission or turned-off failure after the
  dog's last words wins over a later generic one;
- the fold (`needsPerson` in `src/lib/quiet-lines.ts`): safety blocks and the Mac
  permission message are found in the raw cause;
- the desktop row (`ErrorRow`): the safety, usage-sharing and Mac checks run on
  `detail`.

The other readers only test that a row is a failure (`name` starts `error:`,
`ok: false`): the account battery's limit row, the promise nudge, the restart
pickup's answered check, status lines and digests.

## Stopped, in the header and the sidebar

| Work state | Before | Now |
| --- | --- | --- |
| `stopped`, cause `you` | Stopped by you | Stopped by you |
| `stopped`, detail `stalled` | Stopped: no progress for too long | Stopped: no progress for too long |
| `stopped`, detail `closed` | Stopped: the engine closed | Stopped before it finished |
| `stopped`, cause `engine` or `infrastructure` | Stopped: the engine reported an error | Stopped before it finished |

The phone should use the same words for the same states.

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
it, and that attempt's own "View work" opens there too. `foldExchanges` in
`src/lib/quiet-lines.ts` does this as a `recovered` item; it walks back over the
failure rows and hidden rows (digests, hidden tool calls) and stops at anything
else shown (the person's message, the dog's words).

A row that asks the person to do something is never folded, and when one is in
the block nothing is folded: sign-in (`setup`), the update prompt
(`claudeUpdate`), limits (`quota`), places (`place`), provider safety blocks and
the Mac permission message. The watch's or pickup's own failure rows (`pickup`
set, `ok: false`) are never folded, so a recovery that fails shows as usual.
Stored messages do not change. "View work" no longer carries an "Issue recorded"
label.

## What the phone must read to show the same

- Failure row: show `tool.name` after `error:` as the line; when `tool.detail`
  is a string, put it under a Details disclosure. Today the phone shows
  "Couldn't finish: <line>"; with plain lines it should show the line alone.
- Sign-in: `tool.setup === true` marks a sign-in row, including the new ones
  whose reason was found in the raw cause.
- Recovered turn: a message with `kind: "activity"`, `tool.ok === true`,
  `tool.pickup` of `"watch"` or `"restart"` and `tool.name` starting
  `recovery:`. Walk back from it over failure rows (`kind: "activity"`,
  `tool.ok === false`, `tool.name` starting `error:`, no `tool.pickup`),
  digests and hidden tool rows, stopping at the person's message or any shown
  row. If any of those failure rows has `tool.setup`, `tool.claudeUpdate`,
  `tool.quota` or `tool.place`, or its `tool.detail ?? name` is a provider
  safety block or starts "CUA Driver is not ready", fold nothing. Otherwise hide
  them and the attempt's work receipts started since that stopping row, and offer
  them behind Details on the recovery line.
- Stopped state words: `Stopped before it finished` for cause `engine` or
  `infrastructure` and for detail `closed`; `Stopped: no progress for too long`
  for detail `stalled`; `Stopped by you` for cause `you`.

## How it was proven

Unit tests:

```sh
pnpm exec vitest run shared/plain-failure.test.ts shared/failed-turn.test.ts \
  server/laterdog/helpers-stopped.test.ts server/drivers/claude-tasks.test.ts \
  server/laterdog/stall-watch.test.ts server/laterdog/stall-watch-raw.test.ts \
  src/lib/recovered-fold.test.ts src/lib/quiet-lines.test.ts src/lib/work-state.test.ts
```

`shared/plain-failure.test.ts` holds both tables with samples taken from the
drivers' message templates, including the line seen live on November 13, and
checks that `detail` never carries a token. `server/laterdog/stall-watch-raw.test.ts`
checks that the watch explains a turned-off or signed-out account, that a dog
called "Login Helper" or "Safety Sam" changes nothing, and what it does with an
overloaded service before and after it became a failure row (before: settled,
nothing carried on; now: carried on, at most twice, as for any engine stop). It
carries on after 5xx, 529 overloaded, 429 and a timed-out or dropped connection. It
never carries on after an error retrying cannot fix: `API Error: 4xx` other than
429, `invalid_request_error`, `not_found_error`, "Prompt is too long", a context
limit, "Request too large", "There's an issue with the selected model", "Credit
balance is too low", a safety block, a spend limit; sign-in (401), permission (403)
and a turned-off account are explained instead. `src/lib/recovered-fold.test.ts`
checks failure plus recovery gives one visible row, a failure alone stays the
failure, and a block holding a sign-in, update, safety or Mac permission row is
never folded.

Fixture runs in the real renderer, headless (recipe in [Chat UI](chat-ui.md)):

```sh
FAKE_CLAUDE_TRANSIENTS=3 FAKE_CLAUDE_STATE=/path/to/state \
  node --experimental-strip-types scripts/control-laterdog.ts ui launch
FAKE_CLAUDE_MODE=api-error \
  node --experimental-strip-types scripts/control-laterdog.ts ui launch
```

| Case | Stored row | What the screen showed |
| --- | --- | --- |
| Engine failing three launches with a 503 | `error: Pepper stopped because the service behind its account is busy or briefly unavailable. Try again in a moment.`, `detail: "claude exited 5 before result: claude: API error (503): …"` | The sentence, Details (the raw line), Retry; the header and the sidebar said "Stopped before it finished". |
| The same, after the stall watch carried on with its default timings | the failure row, then `recovery: … carrying on by itself.` (`pickup: "watch"`), then the answer | The recovery line with Details, the answer, one "View work". No failure row and no "Issue recorded". Details opened the failure row and the failed attempt's own "View work". |
| `api-error` mode (`API Error: 529 Overloaded. …`) | one failure row, no reply from the dog | "The service behind Pepper's account is busy or briefly unavailable. Try again in a moment." with Details (the raw line) and Retry; no bubble with the raw text. |
| A sign-in failure, a helpers line, then a recovery line | fixed data in `scripts/testing/failure-fold-preview.tsx`, rows made by `failedTurnTool` | Both failure rows stay on screen above the recovery line; nothing is folded. |

The fixed-data preview is loaded into a launched `ui` page with
`ui eval --js "document.body.innerHTML = '<div id=\"root\"></div>'; import('/scripts/testing/failure-fold-preview.tsx')"`.
It has no engine, so the sign-in row shows no sign-in button there. The browser
console had no errors in either run. `server/laterdog/stall-watch.e2e.test.ts`
("an engine that exits mid-turn …") also checks the row a killed engine leaves.

## Not proven

- No real engine was made to die or report an API error with this code; the
  sentences were checked against the drivers' templates, the fake engine and the
  line seen live.
- A restart pickup folding its turn's failures is proven by unit tests only.
- The sign-in button on a reason found in the raw cause is shown only when the
  dog's own account is signed out; a carry-on to another account that needs
  signing in says so in words.
- A usage limit found in the raw cause is said in words; it does not get the
  limit row.
- The Claude driver delivered API errors as replies; the Codex, Pi and
  chat-API drivers were read and already send them as errors. The ACP drivers
  were not checked.
- The phone does not read `detail`, fold recoveries or use the new stopped words yet.
