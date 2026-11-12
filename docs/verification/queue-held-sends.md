# Messages held while the home wakes: queue, Send now, cancel, Not sent

Branch `atelier/queue-closure-desktop` (pull request #164). It carries the edge
half (`deploy/laterdog/home/**`), the home half (`server/**`) and the desktop
and web half (`src/**`) in one pull request, and replaces pull requests #157
and #159. Branch `atelier/queue-followup` sits on its head `e8d89aa` and closes
the third review's three Should fix items; this note describes that head.

## What a person sees

- A message sent while the home is asleep or starting shows as queued, with its
  words. It goes to the dog once the home is up, once.
- Send now and cancel work on that queued message from the moment it is sent,
  in a dog's chat and in a group chat.
- If the home refuses the message, or does not come up within the hour, the
  message comes back in the Not sent row with its words and Send again. It never
  disappears silently.
- Asking about a queued message that is gone says "That message is no longer
  waiting. It may already have been sent." A failure that carries no words says
  so in words, never as the name of a type.

## What each layer does

### Device (`src/lib/held-sends.ts`, `src/state/send-outbox.ts`, `src/state/store.tsx`)

- When a send is answered with `queued` and a queue id equal to the send id,
  the edge is holding it. The device keeps its own copy (words, chat, reply
  target) in local storage under `laterdog-held-sends`. Every such send gets a
  copy, with or without a composer behind it: quick replies, call transcripts,
  teach-a-trick, typed card replies, group messages.
- A send whose receipt this device never read (the connection dropped, or the
  app was quit in that moment) is still in the device's outbox. When a refresh
  shows it waiting at the edge (the edge's own queue row, or a `desk-` line),
  the device writes the same copy from the outbox item before it lets the
  outbox item go, so a later drop still comes back as Not sent with the words.
  The same happens when the waiting row arrives by itself as a queue frame,
  and when the edge's own `desk-` line arrives by itself as a `message` frame
  on the event stream (the edge sends that line when it answers a held message
  itself). A row or line that shows the home took the message writes no copy,
  and neither does one the same refresh or frame also shows at the home.
- After a restart, at the first refresh, the device puts a queued row back for
  every held copy that belongs to a group chat and that the home does not
  already show, so a held group message is on screen with cancel and Send now.
  (The edge's saved chat list carries such rows only for dogs' chats.) It does
  this once per start. The row is put back before the edge is asked, so a
  message the home took while the app was closed can show as queued until the
  edge's answer arrives; when the edge says it neither holds nor dropped a
  message, its queued row goes together with its copy if the chat shows the
  message. Otherwise the copy is kept (see the next point).
- The copy is let go only on a definite answer: the home shows the message in
  the chat or in its own queue (a queue row whose id differs from the send id,
  or a line whose id does not start with `desk-`), the edge says it no longer
  holds it and did not drop it and the chat shows the message, or the person
  cancels it.
- "Neither held nor dropped" means the edge handed the message to the home, so
  an absent chat line is not proof it was lost (the event stream may lag). When
  the edge says so on its own timer and the chat lacks the message, the device
  keeps the copy and asks the home once for its chats (the same read as a
  refresh); if that read fails it asks again on the next round. Only a settle
  that carries a real refresh may turn such a message into Not sent, and only if
  the refresh lacks it too. A refresh that has it releases the copy as delivered.
- A card answer travels the same way (`card` on the outbox item and the copy).
  The card shows the answer as waiting until the home's receipt, or until a held
  answer is delivered, and only then is marked answered; a refused, dropped or
  cancelled answer makes the card answerable again. Any send that ends in a
  final failure without a composer to recover it records the Not sent row itself.
- The edge's own rows and lines in a refresh do not count as landed, so a
  refresh answered by the edge keeps the copy.
- While a copy exists the device asks the edge's held list (`GET` on `HELD_SENDS_PATH` from
  `deploy/laterdog/home/src/desk.ts`, with `?ids=…`) on a
  timer: 30 seconds, doubling to a five minute cap. Every refresh starts the
  wait over. The timer stops when nothing is held, when the edge says to sign
  in again, and when the store goes away; it is never started from the send
  path's request. At most 50 ids go in one request, and only the ids asked are
  settled.
- `held` wins over `dropped` for the same id. A failed ask (network error,
  timeout, 5xx) is not an answer: the copy stays and the device asks again.
  Only "there is no edge" (404) starts the 65 minute rule.
- There is no separate hook on sign-out or on a change of home: a 401 or 403
  from the edge stops the timer, and the timer is thrown away with the store's
  outbox when the store goes away (the second read in code, the first tested).
- One settle runs at a time. A refresh that arrives during one is folded into a
  single follow-up run with the newest chats.
- A dropped send takes its queued row away, goes to the Not sent row with its
  words, and shows one notice. Send again reuses the send id; the re-held message
  shows as queued again.

### Edge (`deploy/laterdog/home/src/desk.ts`, `host.ts`)

- Holds up to 50 sends per home for up to an hour while the home cannot take
  them, and delivers each once when it can.
- Answers Send now and cancel for a held send by its send id, for
  `/api/bots/:id/queue/:queueId` and `/api/groups/:id/queue/:queueId`. Cancel removes it before
  the home ever sees it. A send a dog is already answering is not cancelled and
  says so.
- Remembers up to 50 dropped sends for seven days (`refused` or `expired`) and
  answers the held list with `held` and `dropped` for the ids asked. An
  id is never in both lists: held again or delivered removes it from dropped.
  A dropped record older than seven days is removed when the list is read (a
  device asks, or any request reaches the awake home), not only when another
  drop is recorded.
- Expiry and questions about held sends wait for a delivery in flight.

### Home (`server/steer-queue.ts`, `server/channel-queue.ts`, `server/index.ts`, `server/laterdog/queued-steer.ts`)

- Queue rows persist with the sender's send id (`chat_followups.send_id`).
  Cancel and Send now find a queued message by its own queue id or by the
  sender's send id, for dogs and for group chats, before and after a restart.
- Send now reports a message as sent only when the item it names left the
  queue. Asking about a later message that stays queued answers with the ids
  that went, not the asked one.
- Send now on a message that already landed answers `sent`; cancel on it
  answers 404 "no such queued message", which the device shows as the plain
  sentence above. The machine-readable shape is unchanged.
- A send repeated with the same send id adds nothing (the home's own
  deduplication, unchanged).

## Review findings (`reviews/queue-desktop-server.md`)

| Finding | State | Proof |
| --- | --- | --- |
| D1 refresh served by the edge erased the copy | fixed | `src/state/send-outbox.test.ts` "keeps the copy through a refresh the edge answers while it still holds the message…"; `src/state/held-sends-wiring.test.ts` first test |
| D2 a drop learned only at a refresh | fixed | `src/state/send-outbox.test.ts` "asks the edge by itself while a message is held…", "learns that the edge dropped the message without any refresh…", "after a restart, asks about every held message… in one request…", "stops asking when the edge says to sign in again and when the store goes away…" |
| D3 held and dropped for one id; send again after a drop | fixed | `src/lib/held-sends.test.ts` "believes held over dropped…"; `src/state/send-outbox.test.ts` "after a drop, shows the message sent again as queued…" |
| D4 Send now reported a still-queued message as sent | fixed | `server/laterdog/queued-steer.test.ts` "leaves out the asked id when Send now on a later message only sent the one ahead of it"; `server/steer-e2e.test.ts` "Send now on a later message from someone else reports only the message that went and leaves the asked one queued" |
| D6 sends without a composer got no copy | fixed | `src/state/send-outbox.test.ts` "keeps a copy for a send with no composer behind it…"; wiring test "keeps a group message the edge holds, with no composer behind it…" |
| D7 group routes did not know send ids | fixed | `server/channel-queue.test.ts` three send id tests; `server/steer-e2e.test.ts` room tests; `server/chat-followups-restart.test.ts` cancels a group message by send id at a running home |
| D8 copy removed without a definite answer | fixed (failed ask, groups of 50); third point accepted as is | `src/lib/held-sends.test.ts` "takes a failed ask as no answer at all…", "asks about at most as many sends at once as the edge reads"; `src/state/send-outbox.test.ts` "keeps the copy however long asking the edge fails…", "asks about fifty messages at a time…" |
| D10 overlapping settles | fixed | `src/state/send-outbox.test.ts` "settles one refresh at a time…", "runs a refresh that arrived during a settle once more afterwards…" |
| Error text | fixed | `src/lib/plain-client-error.test.ts` "says a queued message that is gone in a sentence…"; wiring test "forgets the copy when cancel is answered, and says a message that is gone in a sentence" |
| Lookup by send id after a home restart | fixed | `server/steer-queue.test.ts` and `server/channel-queue.test.ts` "after a restart, still finds … by the sender's id, so a send again adds nothing and cancel by that id works" (restore from the durable journal, then cancel); `server/laterdog/queue-send-id-restart.e2e.test.ts` does it at a running fixture home that is killed and started again |
| The store wiring itself | covered | `src/state/held-sends-wiring.test.ts` drives the app's reducer and the real outbox, eight tests |

## Fixture proofs

All on the Linux cloud computer against fixtures. Nothing here touched a real
home, the Mac app or a phone.

| Case | Where |
| --- | --- |
| Reconnect while the edge holds a message | device: `src/state/send-outbox.test.ts` "keeps the copy through a refresh the edge answers…", "keeps the copy while the connection is down, and on reconnecting takes the home's word…"; wiring test "after a restart, keeps the copy and the queued row while the edge answers the refresh…"; edge: `deploy/laterdog/home/test/desk.test.ts` "keeps a waiting message in the saved chat list" |
| Home restart with the message queued, then cancel by send id | running fixture home, killed and started again: `server/laterdog/queue-send-id-restart.e2e.test.ts` (two messages wait through the restart; the one still waiting afterwards is cancelled by its send id, is never delivered and is refused when sent again, and the other goes once); passed 5 runs of 5. Journal restore at module level: `server/steer-queue.test.ts`, `server/channel-queue.test.ts` |
| Cancel racing Send now and delivery | `server/steer-queue.test.ts` "gives a cancel and a delivery of the same message one winner…"; `server/steer-e2e.test.ts` "gives a cancel and a Send now that arrive together one winner…", "tells a cancel that arrives while Send now is delivering the message that it is no longer waiting, and delivers it once" (running fixture home); edge `deploy/laterdog/home/test/wake-guard.test.ts` "does not answer a cancel from the edge while the message is on its way to the home…" |
| A retry never delivers twice | `src/state/send-outbox.test.ts` "keeps one copy and one queued row when the same send is sent again while the edge holds it"; wiring test "shows one message when the same send is sent again while the edge holds it and again after the home took it"; `server/laterdog/queued-steer.e2e.test.ts` second test; edge `deploy/laterdog/home/test/wake-guard.test.ts` |
| Refused or expired comes back as Not sent with the words | `src/state/send-outbox.test.ts` "puts the message in the Not sent row with its words when the edge says the home refused it or the hour ran out", "learns that the edge dropped the message without any refresh…", and the group and no-composer cases; wiring test first test; edge `deploy/laterdog/home/test/wake-guard.test.ts` "says which held messages it still has, and which the home refused…" |

## Second review (`reviews/queue-164-round2.md`, at `67b7f2e`)

No blocker. Changed after it:

| Finding | State | Proof |
| --- | --- | --- |
| S1 a send whose receipt the device never read got no copy, and a refresh the edge answered erased the outbox item | fixed | `src/state/send-outbox.test.ts` "when this device never read the edge's receipt": "writes the copy from the outbox when a refresh the edge answers shows the waiting row, so a later drop gives one Not sent row with the words and one notice", "does the same when the edge shows the message as its own line in the chat", "writes the copy when the waiting row arrives by itself, and none for a row or a line that shows the home took the message". All three fail on the source before the fix. |
| N1 a held group message was not on screen after a restart | fixed, 17 lines of source | `src/state/send-outbox.test.ts` "after a restart, puts a held group message back on screen as queued at the first refresh, once…"; `src/state/held-sends-wiring.test.ts` "after a restart, shows a group message the edge still holds as queued again, and cancel takes it away for good" |
| N5 old dropped records were removed only when a newer drop was recorded | fixed | edge `deploy/laterdog/home/test/wake-guard.test.ts` "forgets a dropped message seven days later when a device asks about it…", "…when the next message is sent to the awake home"; `deploy/laterdog/home/test/desk.test.ts` "remembers a dropped message once, forgets old ones after the kept time…" |
| N8 this note was out of date | fixed | this section and the next |

Known and not changed:

- N2: a cancel the edge answers after a delivery whose answer was lost does not reach the home, so if the home fails twice around the cancel the dog can still answer a message the person cancelled.
- N3: closed after this review by the merge `0018131`, which brought in the edge's confirmed-session rule: hold, list, cancel and Send now at the edge now need a session the home itself confirmed, so a token that only once got a 200 JSON answer from the home is refused. Pinned by the edge tests named under the third review. What is left of it is the third review's N1.
- N4: Send now or cancel that meets a refusal by the home says "It may already have been sent" for up to 30 seconds before the Not sent row appears, and the home's reason for refusing is not carried to the device.
- N6: the edge keeps the held list as one stored value with a 2 MB limit, so about eight sends near the 256 KB size limit could fail to save while the device is told they are held.
- N7: the held copies are kept under one name for the whole app, like the outbox and the Not sent list, so a desktop window pointed at a different home would ask the wrong home about them; not checked in the Mac app.

## Third review (`reviews/queue-164-round3.md`, at `e8d89aa`)

No blocker, verdict merge. Changed after it, on `atelier/queue-followup`:

| Finding | State | Proof |
| --- | --- | --- |
| S1 the edge's own line arriving on the event stream let the outbox item go with no copy, so a lost receipt and a later refusal lost the words | fixed: the `message` frame handler hands the line's id and chat to the outbox, which writes the copy for a `desk-` line before it lets the item go | `src/state/send-outbox.test.ts` "writes the copy when the edge's own line arrives on the event stream before any receipt, so a later drop gives one Not sent row with the words and one notice, and none for the home's line"; `src/state/held-sends-wiring.test.ts` "keeps the words when the edge's own line arrives on the event stream and the receipt never does, and gives them back as Not sent once when the home refuses, with one request sent". Both fail without the fix. |
| S2 no test failed when the list route stopped asking for a confirmed session | fixed, test only | edge `deploy/laterdog/home/test/desk.test.ts` "says which messages it holds to a session the home confirmed, and nothing to a stranger or to a caller with no credential". With `knownDevice` taken off the list route it fails (`expected 200 to be 503`), 1 failed of 312. |
| S3 a held group message the home took while the app was closed stayed on screen as queued after its copy was gone | fixed: an answer of neither held nor dropped takes the queued row away where the copy is removed | `src/state/send-outbox.test.ts` "after a restart, takes a held group message's queued row away with its copy when the edge says it neither holds nor dropped it, and leaves the one it still holds"; wiring test "after a restart, turns a group message's queued row into Not sent with its words once the edge says it neither holds nor dropped it and the chat does not show it"; `src/lib/held-sends.test.ts` "reads what the edge really answers". The first two fail without the fix. |
| N5 one line of the copy-from-outbox change was pinned by no test | kept and tested; it is not dead: on a queue frame that shows one send both at the edge and at the home it is the only thing that stops a copy being written | `src/state/send-outbox.test.ts` "writes no copy for a message the same refresh or the same queue frame also shows waiting at the home"; fails without the line |
| N6 this note described `646d219` | fixed | this section and the next |
| Not in the review: the docs check failed on this note at `e8d89aa`, 3 failed of 6 (test files named without their folders, the edge's held list cited as a route of the home, and the note not linked from the index) | fixed, this note and the index only | `scripts/testing/verification-docs.test.ts`, 6 passed |

Open and known, not changed:

- N1: while the home is up, the edge answers the list, cancel and Send now for a session it confirmed earlier without asking the home again, and learns nothing from those requests. A session the owner signed out at the home, not used on any other route since, can still list, cancel or Send now a message stuck at the edge if it knows the send id.
- N2: seven days after a drop the edge forgets it and answers neither held nor dropped. A device that was closed for longer than that then lets its copy go silently: no Not sent row and no words.
- N3: the held copies on the device have no limit of their own and stay while no ask gets a definite answer; nothing clears them at sign-out (the same holds for the outbox and the Not sent list).
- N4: the queued row is put back after a restart for group chats only; a held message in a dog's chat that the edge cannot place in a saved chat list has no row, though its words are safe in the copy.
- The second review's N2, N4, N6 and N7 above.

## What was run

Measured on the Linux cloud computer (Node 24.22.2), 2026-11-11, 19:26 to
19:50 UTC, in a copy holding exactly the tracked files of the head of
`atelier/queue-followup` (the tree hash was compared with the commit's), with
packages linked from the `e8d89aa` checkout. Each command ran under
`flock -s ~/heavy.lock`; logs are in `~/qf/logs`. Fixtures only.

| Gate | Result |
| --- | --- |
| `pnpm vitest run src/state src/lib/held-sends.test.ts scripts/no-comments.test.ts scripts/brand-links.test.ts` | 326 passed, 19 files (`src/state/send-outbox.test.ts` 44, `src/state/held-sends-wiring.test.ts` 8, `src/lib/held-sends.test.ts` 9, `scripts/no-comments.test.ts` 14, `scripts/brand-links.test.ts` 3) |
| Edge, `deploy/laterdog/home`, `node node_modules/vitest/vitest.mjs run` | 312 passed, 31 files (`deploy/laterdog/home/test/desk.test.ts` 38, `deploy/laterdog/home/test/wake-guard.test.ts` 36) |
| Edge, `tsc --noEmit` in `deploy/laterdog/home` | exit 0. It reads `src/**` only, so the edge tests are run but not type-checked by any gate |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | 0 warnings, 0 errors, 3063 files |
| Without the S1 fix, the three held message test files | 2 failed of 61: `src/state/held-sends-wiring.test.ts:294` and `src/state/send-outbox.test.ts:411`, both `expected [] to deeply equal` the kept copy |
| Without the S3 fix, the same files | 2 failed of 61: `src/state/held-sends-wiring.test.ts:332` `expected [ { …(2) } ] to be undefined`, `src/state/send-outbox.test.ts:856` |
| Without the N5 line, the same files | 1 failed of 61: `src/state/send-outbox.test.ts:440` `expected [ { …(6) } ] to deeply equal []` |
| `pnpm vitest run scripts/testing/verification-docs.test.ts` | 6 passed. At `e8d89aa` the same command gives 3 failed of 6, all three naming this note |
| Edge, list route without `knownDevice`, whole edge suite | 1 failed of 312: `deploy/laterdog/home/test/desk.test.ts:397` `expected 200 to be 503` |
| Whole `pnpm vitest run` | not run for this follow-up |
| Server tests, `wrangler types` | not run for this follow-up; no server file and no edge source file changed |

### Earlier, before the follow-up

Measured on the Linux cloud computer (Node 24.22.2), 2026-11-11, 14:43 to
14:54 UTC, in a git checkout holding exactly the tracked files of `646d219`:
that branch with `origin/main` at `4b377d9` merged in (no conflicts). Fixtures
only. The third review's own runs at `e8d89aa` are in its file: the edge suite
gave 311 passed, and the three held message test files 56 passed.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` (`tsc -b && tsc -p tsconfig.server.json`) | exit 0 |
| `pnpm lint` (`oxlint --deny-warnings .`) | 0 warnings, 0 errors, 3055 files |
| Edge, `deploy/laterdog/home`, `pnpm test` | 301 passed, 31 files (`deploy/laterdog/home/test/wake-guard.test.ts` 36, `deploy/laterdog/home/test/desk.test.ts` 27) |
| Edge, `pnpm check` (`wrangler types && tsc --noEmit`) | exit 0 |
| `pnpm vitest run src scripts/no-comments.test.ts scripts/brand-links.test.ts` | 3590 passed, 410 files (`src/state/send-outbox.test.ts` 41, `src/state/held-sends-wiring.test.ts` 6, `src/lib/held-sends.test.ts` 9, `scripts/no-comments.test.ts` 14, `scripts/brand-links.test.ts` 3) |
| Server: `channel-queue`, `steer-queue`, `laterdog/queued-steer`, `laterdog/queued-steer.e2e`, `laterdog/plain-error`, `chat-followups-restart`, `chat-followups`, `steer-e2e`, `laterdog/queue-send-id-restart.e2e`, `send-idempotency`, `routes/dog-queue` | 127 passed, 11 files |
| Whole `pnpm vitest run` | NOT FINISHED: started 14:53 UTC in the same checkout. At 15:08 UTC 14 of 1308 test files had reported, slowest first, with other lanes' suites on the same four cores; the only failures so far are the two that fail on main (below). The log is `~/q164/logs/full-vitest.log` and the status `~/q164/logs/status` on the cloud computer; `ALL DONE` in the status file means it ended |

Before the merge, at `54a4b95`: the edge suite gave 295 passed in 31 files, and
`src/state/send-outbox.test.ts` with `src/state/held-sends-wiring.test.ts` gave 47 passed.

Earlier, at `848e88d`: `server/laterdog/queue-send-id-restart.e2e.test.ts`
passed 5 runs of 5.

Two tests fail on main itself on the cloud computer and are not this branch's
(neither file is changed here): `server/config.test.ts` "uses the list again
once a file the server could not read is readable" (it makes a file unreadable
with `chmod 000`, and the cloud computer's user can read any file) and
`server/drivers/agents-proxy.test.ts` "answers the MCP handshake and lists the
agents tools". Earlier whole-suite runs on this branch also saw
`server/workspace.test.ts` "fails the write, changing nothing, when the archive
exists but cannot be read" (the same `chmod 000` cause) and
`server/delta-context.e2e.test.ts` "resets Claude's native context on edit,
then resumes only the replacement branch"; the last one has not been run alone
or compared with main.

## Left

- The whole `pnpm vitest run` has never finished on the cloud computer for this
  branch. The run at `e8d89aa` writes to `~/q164b/logs/full-vitest.log`
  (`~/q164b/logs/status` had no line for it at 19:30 UTC); any failure other
  than the ones named above needs a look.
- N2, N4, N6 and N7 from the second review and N1, N2, N3 and N4 from the third
  are open by decision.
- Everything under "what still needs a real home or the app" below.

## Fixture-only, and what still needs a real home or the app

- Everything above is fixture-only. The edge tests run the Worker's own classes
  against in-memory storage and a fake home; the server e2e tests run a real
  home process with the fake engine; the device tests run the real reducer and
  outbox against a scripted request function.
- Not observed on a real home: a real sleep and wake with a message held; the
  hour running out; a refusal by a real home.
- Not observed in the Mac app or a browser window: the queued row, the Not sent
  row and the notice as drawn; the timer across a real laptop sleep.
- The phone app has its own copy of the device half in `later-dog-phone`
  (separate lane); nothing here changes it.
- Provider receipts: none. No real model was called.

## What a release needs

All three, in this order, because the device half relies on answers only the
new edge and the new home give:

1. Home Worker deploy (`deploy/laterdog/home`), a full `wrangler deploy`: the
   edge's Send now, cancel and held list answers.
2. Home code (the server bundle): send id lookup for cancel and Send now, group
   routes, the honest Send now answer.
3. Desktop build and the web app (`src/**`): the held copy, the timer, the Not
   sent row, the plain sentence.

An old device against a new edge and home keeps working as before. A new device
against an old edge gets 404 from the held list and falls back to the 65
minute rule.
