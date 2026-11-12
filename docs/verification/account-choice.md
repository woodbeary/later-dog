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
| Cannot run, Keep going on | The same-engine account that is on, signed in, offers the model and is not held, ranked by what is left in the binding window (the tighter of session and week). Paid credits count as available. Nothing at 5% or under while another has more; unknown readings come after known room. The account already covering stays while it is as good. |
| Cannot run, Keep going off | The chat waits for usage on the chosen account. |
| Coming back | The next message after the chosen account can run again goes to it. |
| Engines | Never crossed by the home. With no same-engine account free the chat waits; the usage and stall watches carry it on. Only a person's own pick on the limit row (`byHand`) moves it to another engine, for that chat until the chosen account is back. |
| A pick while the dog works | The running turn finishes where it is; the pick takes the next message. The picker says "From the next message" at once. |
| Helpers | A helper starts on its dog's chosen account, not the account covering for it. |

## What the person sees

The server sends `accountBattery.routed[threadId]` (`WireAccountRoute` in
`shared/wire.ts`): `{ from, on, model, next? }`. `on` and `model` come from the
execution evidence: the running turn's dispatched account and the model the
provider reported, or, when idle, the last finished turn (saved in
`account-battery.json` as `ran`). There is no entry when the turn ran on the
chosen account.

The desktop chip and picker show `on` and `model`, keep the chosen account
marked as selected, and add one quiet line:

- "Running on anthony until daniel is back" while the chosen account cannot run;
- "From the next message" when the next message goes somewhere other than where
  the current or last turn ran (a pick, or the chosen account being back).

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

Unit tests (all passing): `server/laterdog/account-choice.test.ts` (27: every
rule and every incident above), `account-battery.test.ts`,
`account-battery-fallback.test.ts`, `account-pinned-engine.test.ts`,
`account-used-up.test.ts`, `account-no-early-switch.test.ts`,
`continue-on-account.test.ts`, `execution-evidence.test.ts`,
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
| Pick account 2 while account 1 is mid-turn | `routed` at once `{ from: claude-two, on: claude, next: true }`; the turn is not interrupted and finishes on account 1; the next message runs on account 2 and the line goes away |
| Helper started while its dog is covered | The dog's line reads `{ from: claude, on: claude-two }`; the helper keeps the dog's choice (claude) and runs on claude-two while claude is out |
| Keep going off | Stays on Claude, reports the limit (existing scenario) |

All 21 scenarios in the file passed in one run.

## Not proven live

- No run on a real home or with real readings. The fake engine reports no plan
  readings, so "most left" and "credits count" are proven by unit tests only;
  the fixtures fall back to the person's order.
- After a server restart the running-turn half of the line is empty until the
  next turn starts; the last finished turn is kept on disk.
- The phone app still reads the old `{ from, on }` meaning; see below.

## What the phone app must change

1. Read `accountBattery.routed[threadId]` as `{ from, on, model, next? }`: show
   `on` and `model` in the chip, keep `from` (the person's choice) marked as
   chosen in the account picker.
2. Show one line: `next` true, or `from` different from the dog's current
   choice, gives "From the next message"; otherwise "Running on {on} until
   {from} is back". Drop "is used up, running on" and the other old lines.
3. A tap on an account while the dog works must not wait for or expect an
   interrupted turn; the line above appears with the next config frame.
4. On the limit row, send `byHand: true` on every tap that continues on another
   account, suggest only accounts of the dog's own engine, and offer another
   engine only as an explicit pick from the list.
