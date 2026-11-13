# Account choice: the account on screen is the one in use, and the choice sticks, November 12

## What it is for

A person with several AI accounts picks one for a dog. That pick must hold, the
account and model shown for the dog must be the ones that really ran, and when
the picked account cannot run the work must carry on without ever leaving the
dog's engine by itself.

## One decision

`decideAccount` in `server/laterdog/account-choice.ts` is a pure function. It
takes the person's choice (account, model, effort), Keep going, every account's
engine, switch, sign-in and model list, the saved holds (already reconciled with
fresh readings), the usage readings with paid credits, the account the chat last
ran on and an account the person picked by hand on a limit row. It returns the
selection to run, and why: `chosen`, `covering` (with the reason the chosen
account cannot run and until when) or `waiting`.

Every path that places a turn goes through it: `AccountBattery.route` (each new
message, carry-ons after a restart or a reset, rooms), `AccountBattery.nextAccount`
(a turn that hit its limit), `AccountBattery.readyAt` (when a waiting chat can
run, via `choiceReadyAt`) and the picker's line (`shownRoute`).

| Rule | What the code does |
| --- | --- |
| The choice is a pin | While the chosen account is on, signed in and not held for the model, the turn runs there, whatever the others have left. Load spreading across accounts is gone. |
| Cannot run, Keep going on | The same-engine account that is on, signed in, offers the model and is not held, ranked in four groups, best first: known plan room above 5% (with or without paid credits); no reading yet; paid credits but no plan room; 5% or under with no credits. Inside a group, the most left in the binding window (the tighter of session and week), then the person's order. The account already covering stays unless it is 5% or under with no credits and a better one exists, or it is on paid credits only and another account has known plan room. One with no reading is never left, so a chat does not hop while readings arrive after a restart. |
| Cannot run, Keep going off | The chat waits for usage on the chosen account. |
| Needs the person | When the chosen account is signed out, failed to sign in or is switched off and no same-engine account can cover, a kept turn is not rerun, and a new message or any queued message for a switched-off account is held instead of run on it (a signed-out account is left to the engine). An engine whose account is switched off refuses every turn with "{account} is turned off" (`server/laterdog/turned-off.ts`), so no other path runs there either. A chat whose own model cannot run first gives way to its dog's model where the Engines row allows it; the hold is decided only for the account the turn would then run on. The wait is saved in `limit-hold.json` and found again after a restart. The chat shows Needs you with "Sign in to {account} again" or "Turn {account} back on" (`server/laterdog/account-needs-you.ts`) only when it will carry on by itself; an open question still wins. Such a chat has no carry-on time in `accountBattery.waiting` and does not keep usage readings refreshing. Apps hear once when the wait starts and once when it ends. The usage watch rechecks the decision each tick, right after an account setting changes and right after a pick; cancelling the held message ends the wait; once the account can run, the work carries on by itself (`server/laterdog/person-wait.ts`). |
| Coming back | The next message after the chosen account can run again goes to it. |
| Engines | Never crossed by the home. With no same-engine account free the chat waits; the usage and stall watches carry it on. Only a person's own pick on the limit row (`byHand`) moves it to another engine, for that chat until the chosen account is back. A chat picked onto an account that is then switched off or signed out follows its dog's model only when the dog is on the same engine; otherwise the pick stays and the chat shows "Turn X back on" or "Sign in to X again". Only a chat whose account is gone, or whose engine is not installed, follows its dog onto another engine, since it could never run otherwise (`server/laterdog/turn-selection.ts`). Every hold, pickup, carry-on time and Needs you line decides on that same selection. |
| A pick while the dog works | The running turn finishes where it is; the pick takes the next message. The picker says "From the next message" at once. |
| Helpers | A helper starts on its dog's chosen account, not the account covering for it. |

## What the person sees

The server sends two records of `WireAccountRoute` (`shared/wire.ts`,
`{ from, on, model }`), and a chat is in at most one of them:

- `accountBattery.routed[threadId]`: the chosen account `from` cannot run and the
  next message also runs on `on`. This is the meaning every released app reads.
- `accountBattery.fromNextMessage[threadId]`: the next message goes somewhere
  other than where the current or last turn ran (a pick, or the chosen account
  being back). Released apps do not read it, so they never say "running on" about
  a chat that is not.

`on` and `model` come from the execution evidence: the running turn's dispatched
account and the model the provider reported, or, when idle, the last finished
turn (saved in `account-battery.json` as `ran`). There is no entry when the turn
ran on the chosen account. `AccountBattery.status` splits `shownRoute` into the
two records.

The desktop chip and picker read both, show `on` and `model`, keep the chosen
account marked as selected, and add one quiet line:

- "Running on anthony until daniel is back" for `routed`;
- "From the next message" for `fromNextMessage`.

## Incidents and their causes

Causes are read from the code as it was before this change and reproduced by the
unit tests named; none was confirmed against the home's own logs.

| Date | What he saw | Cause in code | Decision |
| --- | --- | --- | --- |
| 11-03 | ChatGPT shown running Opus 5.5 | `pickAccount` fell through to the other engine once every Claude account rested; the chip paired the routed account with the chosen model | 1, 4 |
| 11-04, 11-06 | Picks daniel, still shows another account; "sticky"; switching mid-work does not take | `routed` came from saved `away`/`placed` state, not from what ran; a mid-turn pick interrupted and re-ran the turn, or did nothing when the battery routed elsewhere | 1, 6 |
| 11-06 | Everything moved to adam at 1% while anthony had the most | `spreadTo` ranked by fewest running dogs first, then room, and `canTake` let a nearly empty account win | 2, 5 |
| 11-07 | Helpers on the wrong account | `inheritedHelperSelection` copied the account the parent was running on, so a covering account became the helper's own choice | 7 |
| 11-07, 11-10 | Used up when it had reset; ChatGPT switching away with credits | Holds not checked against fresh readings; credits not counted (fixed in pull request 161, used here as available usage) | 5 |
| 11-08 | Carries on only when the chat is opened | Nothing rechecked waiting chats without a client (usage watch on the base branch) | 3 |
| 11-09, 11-10 | Shows Claude while running ChatGPT; keeps trying Codex; a Fable dog must stay on Claude | Cross-engine fallback in `pickAccount`, `nextAccount` and `readyAt` for every dog not pinned by the dog_accounts tool | 4 |

## How it was proven

Unit tests (all passing): `server/laterdog/account-choice.test.ts` (every
rule and every incident above), and, in the same folder,
`server/laterdog/account-needs-you.test.ts`, `server/laterdog/person-wait.test.ts`,
`server/laterdog/battery-view.test.ts`, `server/laterdog/carry-on.test.ts`,
`server/laterdog/carry-on-restart.test.ts`, `server/laterdog/usage-watch.test.ts`,
`server/laterdog/account-battery.test.ts`, `server/laterdog/account-battery-fallback.test.ts`,
`server/laterdog/account-pinned-engine.test.ts`, `server/laterdog/account-used-up.test.ts`,
`server/laterdog/account-no-early-switch.test.ts`, `server/laterdog/continue-on-account.test.ts`,
`server/laterdog/execution-evidence.test.ts`, `server/laterdog/turn-selection.test.ts`,
`src/lib/routed-line.test.ts`, `src/components/ModelPicker.simple.test.ts`,
`src/components/LimitRow.test.ts`.

Fixtures: `server/account-battery.e2e.test.ts` on the isolated fake-engine
server (two Claude accounts and, where named, a Codex account). Keep receipts
with:

```sh
BATTERY_RECEIPTS_DIR=/path/to/receipts pnpm exec vitest run server/account-battery.e2e.test.ts
```

| Scenario | Result |
| --- | --- |
| The chosen account is used, a limit moves to account 2 and comes back after the reset | One switch line, answer from account 2, then "Back on Claude account 1."; usage booked claude, claude, claude-two, claude-two, claude, claude |
| No other Claude account can run, Codex is free | The chat waits for usage (`accountBattery.waiting`), no Codex thread started, one carry claude to claude-two, no Codex line |
| Pick account 2 while account 1 is mid-turn | `fromNextMessage` at once `{ from: claude-two, on: claude }`, nothing in `routed`; the turn is not interrupted and finishes on account 1; the next message runs on account 2 and the line goes away |
| Helper started while its dog is covered | The dog's line reads `{ from: claude, on: claude-two }`; the helper keeps the dog's choice (claude) and runs on claude-two while claude is out |
| Keep going off | Stays on Claude, reports the limit (existing scenario) |
| Both Claude accounts switched off, new message | Not run on either account; the chat reads Needs you, "Turn Claude account 1 back on"; switching it back on runs the held message on it |
| The same, with a restart while held | Still held after the restart, same line, no carry-on time; runs once the account is back on |
| The same, then the held message is cancelled | The line and the saved wait are gone |
| The same, then a pick of a Codex account | The held message runs on it within seconds |
| Chosen account switched off, the other Claude account on | Runs on account 2; `routed` reads `{ from: claude, on: claude-two }` |

All 26 scenarios in the file passed in one run.

## Not proven live

- No run on a real home or with real readings. The fake engine reports no plan
  readings, so "most left" and "credits count" are proven by unit tests only;
  the fixtures fall back to the person's order.
- After a server restart the running-turn half of the line is empty until the
  next turn starts; the last finished turn is kept on disk.
- The phone app still reads `routed` only and ignores `model`; see below.
- A switched-off account is proven on the fixture (a new message is held, then
  runs once the account is back on). The sign-in wait has unit tests only: the
  fake engine can start an account
  signed out but cannot sign it out or back in during a run.

## What the phone app must change

1. Read `accountBattery.routed[threadId]` as before, plus its `model`: show `on`
   and `model` in the chip, keep `from` (the person's choice) marked as chosen
   in the account picker, and say "Running on {on} until {from} is back". Drop
   "is used up, running on" and the other old lines.
2. Read `accountBattery.fromNextMessage[threadId]` (`{ from, on, model }`): show
   `on` and `model` in the chip, keep the choice marked as chosen, and say "From
   the next message".
3. A tap on an account while the dog works must not wait for or expect an
   interrupted turn; the line above appears with the next config frame.
4. On the limit row, send `byHand: true` on every tap that continues on another
   account, suggest only accounts of the dog's own engine, and offer another
   engine only as an explicit pick from the list.
