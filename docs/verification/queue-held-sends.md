# Messages held while the home wakes: queue, Send now, cancel, Not sent

Branch `atelier/queue-closure-desktop`. It carries the edge half
(`deploy/laterdog/home/**`), the home half (`server/**`) and the desktop and web
half (`src/**`) in one pull request, and replaces pull requests #157 and #159.

## What a person sees

- A message sent while the home is asleep or starting shows as queued, with its
  words. It goes to the dog once the home is up, once.
- Send now and cancel work on that queued message from the moment it is sent,
  in a dog's chat and in a group chat.
- If the home refuses the message, or does not come up within the hour, the
  message comes back in the Not sent row with its words and Retry. It never
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
  A row or line that shows the home took the message writes no copy.
- After a restart, at the first refresh, the device puts a queued row back for
  every held copy that belongs to a group chat and that the home does not
  already show, so a held group message is on screen with cancel and Send now.
  (The edge's saved chat list carries such rows only for dogs' chats.) It does
  this once per start.
- The copy is let go only on a definite answer: the home shows the message in
  the chat or in its own queue (a queue row whose id differs from the send id,
  or a line whose id does not start with `desk-`), the edge says it no longer
  holds it and did not drop it, or the person cancels it.
- The edge's own rows and lines in a refresh do not count as landed, so a
  refresh answered by the edge keeps the copy.
- While a copy exists the device asks the edge `GET /api/held-sends?ids=…` on a
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
  words, and shows one notice. Retry reuses the send id; the re-held message
  shows as queued again.

### Edge (`deploy/laterdog/home/src/desk.ts`, `host.ts`)

- Holds up to 50 sends per home for up to an hour while the home cannot take
  them, and delivers each once when it can.
- Answers Send now and cancel for a held send by its send id, for
  `/api/bots/…/queue/…` and `/api/groups/…/queue/…`. Cancel removes it before
  the home ever sees it. A send a dog is already answering is not cancelled and
  says so.
- Remembers up to 50 dropped sends for seven days (`refused` or `expired`) and
  answers `GET /api/held-sends` with `held` and `dropped` for the ids asked. An
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
| D2 a drop learned only at a refresh | fixed | `send-outbox.test.ts` "asks the edge by itself while a message is held…", "learns that the edge dropped the message without any refresh…", "after a restart, asks about every held message… in one request…", "stops asking when the edge says to sign in again and when the store goes away…" |
| D3 held and dropped for one id; send again after a drop | fixed | `src/lib/held-sends.test.ts` "believes held over dropped…"; `send-outbox.test.ts` "after a drop, shows the message sent again as queued…" |
| D4 Send now reported a still-queued message as sent | fixed | `server/laterdog/queued-steer.test.ts` "leaves out the asked id when Send now on a later message only sent the one ahead of it"; `server/steer-e2e.test.ts` "Send now on a later message from someone else reports only the message that went and leaves the asked one queued" |
| D6 sends without a composer got no copy | fixed | `send-outbox.test.ts` "keeps a copy for a send with no composer behind it…"; wiring test "keeps a group message the edge holds, with no composer behind it…" |
| D7 group routes did not know send ids | fixed | `server/channel-queue.test.ts` three send id tests; `server/steer-e2e.test.ts` room tests; `server/chat-followups-restart.test.ts` cancels a group message by send id at a running home |
| D8 copy removed without a definite answer | fixed (failed ask, groups of 50); third point accepted as is | `held-sends.test.ts` "takes a failed ask as no answer at all…", "asks about at most as many sends at once as the edge reads"; `send-outbox.test.ts` "keeps the copy however long asking the edge fails…", "asks about fifty messages at a time…" |
| D10 overlapping settles | fixed | `send-outbox.test.ts` "settles one refresh at a time…", "runs a refresh that arrived during a settle once more afterwards…" |
| Error text | fixed | `src/lib/plain-client-error.test.ts` "says a queued message that is gone in a sentence…"; wiring test "forgets the copy when cancel is answered, and says a message that is gone in a sentence" |
| Lookup by send id after a home restart | fixed | `server/steer-queue.test.ts` and `server/channel-queue.test.ts` "after a restart, still finds … by the sender's id, so a send again adds nothing and cancel by that id works" (restore from the durable journal, then cancel); `server/laterdog/queue-send-id-restart.e2e.test.ts` does it at a running fixture home that is killed and started again |
| The store wiring itself | covered | `src/state/held-sends-wiring.test.ts` drives the app's reducer and the real outbox, five tests |

## Fixture proofs

All on the Linux cloud computer against fixtures. Nothing here touched a real
home, the Mac app or a phone.

| Case | Where |
| --- | --- |
| Reconnect while the edge holds a message | device: `send-outbox.test.ts` "keeps the copy through a refresh the edge answers…", "keeps the copy while the connection is down, and on reconnecting takes the home's word…"; wiring test "after a restart, keeps the copy and the queued row while the edge answers the refresh…"; edge: `test/desk.test.ts` "keeps a waiting message in the saved chat list" |
| Home restart with the message queued, then cancel by send id | running fixture home, killed and started again: `server/laterdog/queue-send-id-restart.e2e.test.ts` (two messages wait through the restart; the one still waiting afterwards is cancelled by its send id, is never delivered and is refused when sent again, and the other goes once); passed 5 runs of 5. Journal restore at module level: `server/steer-queue.test.ts`, `server/channel-queue.test.ts` |
| Cancel racing Send now and delivery | `server/steer-queue.test.ts` "gives a cancel and a delivery of the same message one winner…"; `server/steer-e2e.test.ts` "gives a cancel and a Send now that arrive together one winner…", "tells a cancel that arrives while Send now is delivering the message that it is no longer waiting, and delivers it once" (running fixture home); edge `test/wake-guard.test.ts` "does not answer a cancel from the edge while the message is on its way to the home…" |
| A retry never delivers twice | `send-outbox.test.ts` "keeps one copy and one queued row when the same send is sent again while the edge holds it"; wiring test "shows one message when the same send is sent again while the edge holds it and again after the home took it"; `server/laterdog/queued-steer.e2e.test.ts` second test; edge `wake-guard.test.ts` |
| Refused or expired comes back as Not sent with the words | `send-outbox.test.ts` "puts the message in the Not sent row with its words when the edge says the home refused it or the hour ran out", "learns that the edge dropped the message without any refresh…", and the group and no-composer cases; wiring test first test; edge `wake-guard.test.ts` "says which held messages it still has, and which the home refused…" |

## What was run

Measured on the Linux cloud computer (Node 24.22.2), 2026-11-11. The first three rows ran at `848e88d`.

| Suite | Result |
| --- | --- |
| Edge, `deploy/laterdog/home`, `pnpm exec vitest run` | 293 passed, 31 files |
| Server files this branch touches plus `server/steer-e2e.test.ts` (`channel-queue`, `steer-queue`, `laterdog/queued-steer`, `laterdog/queued-steer.e2e`, `laterdog/plain-error`, `chat-followups-restart`, `steer-e2e`) | 99 passed, 7 files |
| Device files this branch touches (`src/state/send-outbox`, `src/state/held-sends-wiring`, `src/lib/held-sends`, `src/lib/plain-client-error`, `src/lib/outbox`, `src/lib/drafts`) | 98 passed, 6 files |
| `server/laterdog/queue-send-id-restart.e2e.test.ts`, added after the runs above | 1 passed, 5 runs of 5 |
| Repo gates (typecheck, lint, full vitest with no-comments and brand-links) | see "Full gates" below |

## Full gates

Run on the Linux cloud computer at `848e88d` plus this note, 2026-11-11, started 09:31 UTC.

| Gate | Result |
| --- | --- |
| `pnpm typecheck` (`tsc -b && tsc -p tsconfig.server.json`) | exit 0 |
| `pnpm lint` (`oxlint --deny-warnings .`) | 0 warnings, 0 errors, 3034 files |
| Edge `tsc --noEmit` in `deploy/laterdog/home` | exit 0 |
| Full `pnpm exec vitest run` (includes `scripts/no-comments.test.ts` and `scripts/brand-links.test.ts`) | IN PROGRESS at 10:00 UTC: 46 of about 1270 files done, slowest first. The next helper finds the log at `~/qd-logs/full-vitest.log` and the status at `~/qd-logs/gates.status` on the cloud computer |

Failures seen so far in the full run, all in files this branch does not touch
(`git diff origin/main...HEAD` is empty for each test and for `server/drivers`,
`server/config.ts`, `server/workspace.ts`):

- `server/config.test.ts` "uses the list again once a file the server could not read is readable" and `server/workspace.test.ts` "fails the write, changing nothing, when the archive exists but cannot be read": both make a file unreadable with `chmod 000` and skip only for uid 0. The cloud computer's user can read any file (its process has the capability that overrides file permissions), so the file stays readable. Environment, not code.
- `server/drivers/agents-proxy.test.ts` "answers the MCP handshake and lists the agents tools": the listed tools include `react`, the expected list does not. The catalog lists it without condition, and both files are the same as on main.
- `server/delta-context.e2e.test.ts` "resets Claude's native context on edit, then resumes only the replacement branch": failed in two full runs. Not yet run alone or compared with main; do that before calling it unrelated.

## Left for the next helper, if this one is cut off

1. Read the end of `~/qd-logs/full-vitest.log` for the totals and write them here and in pull request #164.
2. Run `server/delta-context.e2e.test.ts -t "resets Claude's native context on edit"` alone on this branch and on main.
3. Main moved to `0b90a17` after this branch was cut. It merges without conflicts (`git merge-tree`). After merging, run the edge suite, `scripts/no-comments.test.ts`, `scripts/brand-links.test.ts`, the lane's server and device tests, and typecheck.

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
   edge's Send now, cancel and `GET /api/held-sends` answers.
2. Home code (the server bundle): send id lookup for cancel and Send now, group
   routes, the honest Send now answer.
3. Desktop build and the web app (`src/**`): the held copy, the timer, the Not
   sent row, the plain sentence.

An old device against a new edge and home keeps working as before. A new device
against an old edge gets 404 from `/api/held-sends` and falls back to the 65
minute rule.
