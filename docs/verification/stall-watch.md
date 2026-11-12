# Stall watch: no dog goes quiet without a reason, November 12

## What it is for

A dog that was told to work must never sit silent with nothing on screen. Every
quiet chat ends up in one of two places within a few minutes, with no app
connected: the home carries the work on by itself, or the chat shows a
specific state and one plain line saying what stopped.

## Mechanisms

| Mechanism | File | What a person sees |
| --- | --- | --- |
| Usage watch | `server/laterdog/usage-watch.ts` | A dog that ran out of usage with nowhere to move shows **Waiting for usage**, even when no reset time is known. Every two minutes the home rechecks every chat waiting like that, and every five minutes it reads account usage itself, so the work carries on when an account comes back without anyone opening the app. |
| Stall watch | `server/laterdog/stall-watch.ts` | Once a minute the home looks at every chat that still owes an answer: the dog's turn ended on an error, ended right after it said what it would do, never answered, or a teammate's work for it ended without a reply. When nothing is in progress (no turn, no open question, no helpers, no teammate working, no usage wait, nothing queued) and the chat has been quiet for three minutes, it carries the work on, at most twice per message, with one line: "Clover stopped partway (it hit a problem: …), so Clover is carrying on by itself." After that, or when carrying on is not safe, it writes once: "… and has not picked it up again. Send a message to carry on." and the chat's state becomes **Stopped**. A sign-in, permission or safety stop is never retried, only explained. |
| Teammate truth | `server/laterdog/stall-watch.ts` | A chat waiting on a teammate that cannot run (its account is signed out, turned off or the dog is marked unable to run) shows **Needs you** with "Patch can't run until it has a working account" instead of "waiting". A chat whose awaited teammates are all idle with nothing started is treated as stopped and carried on. |
| Helpers count as working | `server/laterdog/work-state.ts` | A dog whose own turn is over while its helpers still run shows **Working**. |

The watch reuses what was already there: the restart and settings pickup
(`restart-pickup.ts`) still owns turns cut by a restart, the promise nudge still
owns successful turns that end on a promise, the turn watchdog still stops a
turn with no events for `LATERDOG_TURN_STALL_MS`, and the account battery still
moves a turn to another account. The stall watch only acts when none of them
is working on the chat. It continues through the same `startTurn` path as the
restart pickup, tied to the person's original message; it never sends a
message in the person's name.

Timings come from `LATERDOG_STALL_WATCH_MS` (default 60 s),
`LATERDOG_STALL_QUIET_MS` (default 3 min) and `LATERDOG_USAGE_WATCH_MS`
(default 2 min). Chats quiet for more than six hours are left alone.

## How it was proven

Unit tests: `server/laterdog/usage-watch.test.ts`, `server/laterdog/stall-watch.test.ts`
(errors that end a turn, promises cut by an error, teammates that gave up,
teammates that cannot run, retries capped at two, no retry after sign-in or
safety stops, limit rows left to the account battery, start failures explained).

Fixtures: `server/laterdog/stall-watch.e2e.test.ts` launches the fake-engine
fixture, swaps the engine for a small wrapper that can kill it on demand, and
restarts the server with short watch timings. Set `STALL_RECEIPTS_DIR` to keep
the JSON receipts (rows and sampled work states):

```sh
STALL_RECEIPTS_DIR=/tmp/stall-receipts pnpm exec vitest run server/laterdog/stall-watch.e2e.test.ts --testTimeout 400000
```

What the fixtures showed, with no app or event stream connected:

| Scenario | Result |
| --- | --- |
| Engine exits mid-turn | The failure line, state Stopped, then about seven seconds later one line "Exit dog stopped partway (it hit a problem: … exited 1 before result), so Exit dog is carrying on by itself." and the answer. One person message. |
| Turn goes quiet | With `LATERDOG_TURN_STALL_MS=60000` the watchdog stopped the turn after about two minutes; the stall watch carried it on six seconds later; state Stopped (stalled), then the answer. |
| Restart mid-turn | The existing restart pickup wrote its one notice and resumed; the stall watch added nothing. |
| Helpers outlive the turn | State stayed Working after the dog's turn ended until the helpers reported; no carry-on line. |
| Usage limit, second account | Existing `server/account-battery.e2e.test.ts` ("continues on account 2 …"): one switch line and the answer from the second account, no client involved. |

A chat that waits for usage with no account and no known reset time is proven
by unit tests only; the fake engine always reports a reset time.

## Not yet proven live

- No run on a real home. First checks there: a turn ended by a real tool error
  is carried on once and the line reads well; a chat waiting on usage with all
  accounts out shows Waiting for usage and carries on after an account returns
  with no app open; a teammate's work cut by pushed server code wakes the dog
  that handed it over.
- Work another dog asked for is still left to its handoff: when the handoff ends
  without a reply, the dog that handed it over is the one woken.
- A dog that only says in words that it needs the person (for example "your Mac
  isn't connected") is not detected; the dog should use a card for that.
