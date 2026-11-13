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
| Stall watch | `server/laterdog/stall-watch.ts` | Once a minute the home looks at chats that show positive evidence that work was cut: an error line after the dog's last words, a teammate that gave up without replying, or a turn the engine reported as failed with no words or with words that only promised more. A turn the engine finished normally is never a stall, with or without words, so a tapback answer to "thanks", an acknowledgement with no reply, a normal wordless turn and a dismissed card are all left alone. When nothing is in progress (no turn, no open question, no helpers, no teammate working, no usage wait, nothing queued) and the chat has been quiet for three minutes, it carries the work on, at most twice per person message, and then explains once and stays quiet. |
| Teammate truth | `server/laterdog/stall-watch.ts` | Any handoff that has not finished counts as work in progress: running, waiting on a third dog, resuming, or queued for a dog that can run. While one is outstanding the dog is never picked back up. A handoff queued for a dog that cannot run (its account is signed out, turned off, or the dog is marked unable to run) shows **Needs you** with "Patch can't run until it has a working account". A teammate that gives up without replying still wakes the dog that handed the work over. |
| Helpers count as working | `server/laterdog/work-state.ts` | A dog whose own turn is over while its helpers still run shows **Working**. |

The lines a person reads never include error text; the failure line above them
already says what failed, and the cause goes to the server log only:

- "Clover stopped before finishing, so it is carrying on by itself."
- "Patch stopped before replying, so Clover is picking the work back up."
- "Clover stopped before finishing and has not picked it up again. Send a message to carry on." (state **Stopped**)
- "Clover stopped because its account needs you to sign in again." or "Clover stopped because it needs your permission to go on." (sign-in and permission stops are never retried; safety stops get the plain stopped line)

"Ended normally" is the turn outcome the home already stores: the newest row of
the turn carrying `turnSucceeded` (the digest row, the terminal reply, or the
failure row). Only `false`, or an error line after the last words, counts as
cut.

The watch starts only after the restart pickup has finished its pass, and a
restart pickup's give-up line after the person's message ("later.dog restarted
again before …") settles the chat. A routine's own turn is never carried on; the
watch asks whether a routine was running at the time of the owed message, as
the restart pickup does.

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
(default 2 min). Chats quiet for more than 30 minutes are left alone, so a
start never carries on old work; turns cut by a restart belong to the restart
pickup.

`LATERDOG_STALL_WATCH=observe` makes the watch log one line per chat and
verdict ("stall watch (observe): <chat> would carry on (<message>: <cause>)")
and write nothing to any chat, start nothing and change no state.
`LATERDOG_STALL_WATCH=off` turns it off. Anything else acts.

## How it was proven

Unit tests: `server/laterdog/usage-watch.test.ts`, `server/laterdog/stall-watch.test.ts`
(errors that end a turn, promises cut by an error, failed wordless turns,
teammates that gave up or cannot run; teammates waiting on a third dog or
queued are working; routine turns judged at the owed message's time; restart
give-up lines settle a chat; no sweep before the restart pickup finishes; settled: tapback-only answers,
acknowledgements with no reply, normal wordless turns, dismissed cards; two
carry-ons at most, a second failed carry-on brings no third, an explained chat
stays quiet across sweeps; no retry after sign-in, permission or safety stops;
the 30-minute lookback; observe mode).

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
| Engine exits mid-turn | The failure line, state Stopped, then one line "Exit dog stopped before finishing, so it is carrying on by itself." and the answer. One person message. |
| Turn goes quiet | With `LATERDOG_TURN_STALL_MS=60000` the watchdog stopped the turn after about two minutes; the stall watch carried it on seconds later with "Quiet dog stopped before finishing, so it is carrying on by itself."; then the answer. |
| Restart mid-turn | The existing restart pickup wrote its one notice and resumed; the stall watch added nothing. |
| Helpers outlive the turn | State stayed Working after the dog's turn ended until the helpers reported; no carry-on line. |
| Observe mode | After the engine exit, one "stall watch (observe)" line in the server log, no line in the chat, nothing started. |
| Usage limit, second account | Existing `server/account-battery.e2e.test.ts` ("continues on account 2 …"): one switch line and the answer from the second account, no client involved. |

A chat that waits for usage with no account and no known reset time is proven
by unit tests only; the fake engine always reports a reset time.

## Seen on a test home, November 12

This branch, combined with the other open work, was pushed to a test home
(`scripts/dev-home.mjs push --account test-desk4`, server pid 21 to 149; the
home then answered `/api/bots` with the `work` field, which only this code
sends). The watch ran in its default acting mode. Receipts are kept outside the
repository.

| What happened | What the watch did |
| --- | --- |
| A dog on an account that was signed out failed its turn at 23:12:47 UTC ("Not logged in"). | Nothing for three quiet minutes; at 23:16:26 one line, "Scout RC stopped because its account needs you to sign in again.", state Stopped, no retry. |
| The person wrote "thanks" and the dog answered with a single emoji. | Nothing, checked for more than three minutes afterwards. |
| A 75-second task of fifteen commands, then two short answers, on the home's included model. | Nothing. |

## Seen with a real engine, November 13

An isolated server on a Mac (a fresh data folder, a test dog, the watch acting,
checking every 5 seconds with 30 quiet seconds) ran a dog on the first coding
engine with a real model. Receipts are kept outside the repository.

| What happened | What the watch did |
| --- | --- |
| The dog was asked for two commands in order, said one line and started the first, a 50-second wait. At 09:32:12 UTC the engine process was killed. The chat's state became Stopped, cause engine. | Nothing for the quiet period; at 09:32:46 one line, "Scout stopped before finishing, so it is carrying on by itself.", and a new turn. At 09:32:54 the dog reported both outputs. It read the first command's saved output and did not run it a second time. |

What this does not show: a real home, a second failure in a row, a server
restart. The failure row above the watch's line still carries the engine's own
exit text.

## Not yet proven live

- The carry-on path has not run on a real home: a turn ended by a real tool
  error carried on once; a chat waiting on usage with all accounts out showing
  Waiting for usage and carrying on after an account returns with no app open;
  a teammate's work cut by pushed server code waking the dog that handed it
  over.
- Work another dog asked for is still left to its handoff: when the handoff ends
  without a reply, the dog that handed it over is the one woken.
- A dog that only says in words that it needs the person (for example "your Mac
  isn't connected") is not detected; the dog should use a card for that.
