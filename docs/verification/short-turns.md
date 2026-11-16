# Short turns: waiting, reading and helper turns

Item 42. A dog that polls a job, re-reads a large file or does a whole lane in one
turn re-sends its whole context on every tool call. Three changes keep that small:

- `run_on_computer` takes `wait_minutes`, a whole number from 1 to 60; anything
  else is refused with a plain sentence. One call waits until the command ends or
  that many minutes pass (`server/laterdog/run-wait.ts`). Without it the call
  still waits 4 minutes, as before. The wait never passes what the engine lets one
  tool call last: 60 minutes on Claude, 9 on Pi (it cuts a tool call at 10), the
  MCP call timeout less one minute elsewhere, never under 4. The dog's side of the
  call is a plain HTTP request with no five-minute header limit, given the wait
  plus two minutes (`server/drivers/agents-client.ts`); when the engine cancels the
  call it hangs up, and the home stops waiting. Stop ends the wait within one
  10-second poll and brings nothing back; a new message in the chat (from the
  person, a teammate or the API) ends it early with "A new message arrived while
  you waited", "still running" and the run_id, so the dog can answer and wait again.
  While a job is still running the answer carries the last 2,000 characters of
  output, the first line that looks like an error, and a note that it was
  shortened; the finished answer keeps the whole tail.
  The tool's description says the same: one call waits until the command ends, up
  to `wait_minutes`; a waiting call keeps the computer awake (it checks every 10
  seconds); only a call that comes back still running needs another, with the
  run_id, within 4 minutes, since the computer sleeps after 5 minutes without a
  call.
- The standing instructions say, in three sentences (`LONG_WORK` in
  `server/laterdog/dog-guidance.ts`): when your next step needs a job, wait with
  one call until it ends, but if a person is waiting on you, wait in short calls
  and answer between them (so a helper waits and a dog with a person stays free to
  answer);
  read the part of a file you need, not the whole file again; when a long step is
  done and the chat is long, note where things stand and hand the next step to a
  fresh helper. A dog cannot compact or restart its own chat mid-turn; a fresh
  helper starts small.
- A helper dog doing a teammate request (never the dog that took the person's
  request, even when it resumes after its helpers) is told, through the engine's
  `PostToolUse` hook, to finish its step and end its turn with a report that
  begins with partly done, once its turn reaches 80 tool calls or 160,000 tokens
  of context, and again every 10 calls after (`server/laterdog/turn-budget.ts`).
  The dog that asked sends the rest as a new request. It is a notice, not a hard
  stop, so the helper still writes its report.

## Numbers

`node scripts/measure-turn-growth.ts`, on the Linux cloud computer. The waiting
rows drive the real `run_on_computer` route and run store against a fake computer
and clock; the reading rows use the real size of `server/index.ts`; the lane rows
are a model of a helper adding 2,000 tokens per step, cut by the real
`HelperTurnBudget`, with the compacted size between turns assumed to be 20,000
tokens. Every row starts at 35,000 tokens and counts each call as re-sending the
whole context; tokens are bytes / 4.

| case | before (main `0651657`) | after |
|---|---|---|
| wait for a 56-minute job | 14 calls, ends at 80,758, 787,310 sent | 1 call with `wait_minutes` 60, ends at 38,263, 35,000 sent |
| same job, called as before (no `wait_minutes`) | 14 calls, 80,758, 787,310 | 14 calls, 46,814, 549,696 (shorter still-running answers) |
| read `server/index.ts` whole 14 times, or 14 parts of 120 lines | 385,840 and 2,770,460 sent, against 58,397 and 639,723 | advice only, numbers unchanged |
| a helper lane of 200 steps | 1 turn, peak 447,000, 47,994,000 sent | 4 turns, peak 160,660, 18,076,340 sent |

The standing instructions grew by 317 bytes (about 79 tokens), 1.4% to 1.6% for
every kind of dog on both engines (`scripts/measure-dog-prompt.ts` against
`server/laterdog/dog-guidance.ts` on main `0651657`).

The lane rows assume a new turn starts at 20,000 tokens. That is not proven: a new
request to the same helper continues its chat, and the home folds only near the
window (160,000 of 200,000), never on a 1,000,000-token window. The saving holds
when the next step goes to a fresh helper, as the instructions now say.

## Tests

- `server/drivers/agents-call-wait.test.ts`: the dog's call still gets an answer
  held back 310 s by a real local server (it failed with `HeadersTimeoutError`
  before), and hangs up when cancelled.
- `server/routes/computer-run.test.ts`: the route stops waiting once the call hangs up.
- `server/laterdog/helper-turn-notice.e2e.test.ts`: through the real server and the
  fake engine, a helper is told at calls 80 and 90; a dog talking to its person and
  a dog resumed after its helper are never told.

- `server/laterdog/run-wait.test.ts`: a job ending after 50 minutes takes 13
  calls with the 4-minute window and one with `wait_minutes`; a still-running
  answer stays under 2,600 characters; the engine caps; Stop, a message from the
  person, a bad `wait_minutes`, the first error line, and a 30-minute wait that
  gets its whole 30 minutes.
- `server/laterdog/dog-guidance.test.ts`: the three sentences for every engine,
  and the existing size cap.
- `server/laterdog/turn-budget.test.ts`: the notice at call 80 and every 10 after,
  at 160,000 tokens, never on a dog's own turn, and only on `PostToolUse`.

## Not proven

- That a real dog on a real engine passes `wait_minutes` and follows the three
  sentences: compare a real helper's context over one lane with and without them
  on an isolated home.
- That a real engine keeps a 60-minute MCP tool call open, and that a Codex dog
  is cut at 9 minutes and not before.
- That a real Claude engine shows the `PostToolUse` added context to the model
  inside a teammate turn; the fake engine only records what the hook answered.
- That a real engine sends `notifications/cancelled` when the person presses Stop
  mid-call, and that the person's message reaches the transcript while the call
  waits (both read in code; the tests drive the route directly).
- The `maxWaitMs` and `personWrote` lines in `server/index.ts`: read in code only;
  the route and the handler they feed are tested.
- A home restarting mid-wait: the dog's call fails and the job runs on.
- Codex and other engines get no helper-turn notice: they have no `PostToolUse`
  hook here, so a Codex helper's turn stays unbounded. There is no test for it:
  no code path could deliver the notice, so a test would pass on its own.
