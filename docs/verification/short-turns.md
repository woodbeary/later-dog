# Short turns: waiting, reading and helper turns

Item 42. A dog that polls a job, re-reads a large file or does a whole lane in one
turn re-sends its whole context on every tool call. Three changes keep that small:

- `run_on_computer` takes `wait_minutes` (1 to 60). One call waits until the
  command ends or that many minutes pass (`server/laterdog/run-wait.ts`). Without
  it the call still waits 4 minutes, as before. The wait never passes what the
  engine lets one tool call last: 60 minutes on Claude, the MCP call timeout less
  one minute elsewhere (10 minutes by default, so 9), never under 4. While a job
  is still running the answer carries only the last 2,000 characters of output;
  the finished answer keeps the whole tail.
- The standing instructions say, in three sentences (`LONG_WORK` in
  `server/laterdog/dog-guidance.ts`): if nobody is waiting on you, wait for a job
  with one call, otherwise run it in the background (so it agrees with "stay free
  to answer"); read the part of a file you need, not the whole file again; when a
  step of long work is done and the chat is long, note where things stand and
  hand the next step to a fresh helper. A dog cannot compact or restart its own
  chat mid-turn; a fresh helper starts small.
- A helper dog doing a teammate request is told, through the engine's
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
| same job, called as before (no `wait_minutes`) | 14 calls, 80,758, 787,310 | 14 calls, 46,450, 547,148 (shorter still-running answers) |
| read `server/index.ts` whole 14 times, or 14 parts of 120 lines | 385,840 and 2,770,460 sent, against 58,397 and 639,723 | advice only, numbers unchanged |
| a helper lane of 200 steps | 1 turn, peak 447,000, 47,994,000 sent | 4 turns, peak 160,660, 18,076,340 sent |

The standing instructions grew by 303 bytes (about 76 tokens), 1.3% to 1.6% for
every kind of dog on both engines (`scripts/measure-dog-prompt.ts` against
`server/laterdog/dog-guidance.ts` on main `0651657`).

## Tests

- `server/laterdog/run-wait.test.ts`: a job ending after 50 minutes takes 13
  calls with the 4-minute window and one with `wait_minutes`; a still-running
  answer stays under 2,600 characters; the engine caps.
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
  inside a teammate turn. The server side is covered by unit tests; the wiring in
  `server/index.ts` (begin on a coordination turn, end on completion, the hook
  route) is read in code only, with no end-to-end test through a fake engine.
- Codex and other engines get no helper-turn notice: they have no `PostToolUse`
  hook here.
