# What fills a chat's context window

A chat's Usage panel shows a row headed This chat, which gives the chat's current number ("31.3k of 200k · 16%").
Opened, the row lists what fills the window, largest first. Tools the engine can load on demand are listed
apart, without a share. A Claude Code chat shows the engine's own count. A Codex or included-model chat shows
the home's estimate, marked "about". When the parts were taken before the chat's last turn, or fall more than 2%
short of its number, the row says "as of …" even while closed, and the bar shows only the current number.

## Contract

`GET /api/threads/:threadId/context`. It has the same scope as `/api/threads/:id/messages`, but the dogs' own
service connection cannot read it.

- 200: `{ at, source: "engine" | "estimate", total, window, parts: [{ id, tokens, deferred? }], compactsAt?, stale? }`
- `id` is one of: `conversation`, `tools`, `instructions`, `skills`, `memory`, `helpers`, `other`, `reserve`, `free`.
  Tools not loaded yet come as `{ id: "tools", deferred: true }` and sit outside the window.
- `stale: true` means the home found the parts older than the chat's last turn, or more than 2% below the chat's
  own number. Each app also decides for itself, with `breakdownIsStale` in `shared/context-breakdown.ts`: the
  parts are older when their `at` is before the chat's `updatedAt` (its last message), before `turnStartedAt` while a
  turn runs, or more than 2% below `usage.context.tokens`. A total above the chat's number is not out of date by itself. The heading and bar always show the chat's own number, and
  the parts appear only in the list.
- An app folds a part id it does not know into "Everything else". It drops a part without a valid size, and refuses only
  an answer that is not a breakdown at all.
- 404 `{ error: "nothing yet" }`: no count yet. 404 `{ error: "no such conversation" }`: not a dog's chat.
  A home without this route answers 404 too, and the app keeps the older single-number row.
- Sizes only: never conversation text, file paths, tool names or model names.

The home asks the engine with one stdin line,
`{"type":"control_request","request_id":"laterdog-context-…","request":{"subtype":"get_context_usage","detail":"full"}}`.
It asks after every turn and when the view opens. An engine that answers "Unsupported control request subtype"
is not asked again in that session. An engine that stays silent twice in a row is not asked again either, but a
late answer clears that count.

## Run on fixtures

```sh
bun run vitest run server/laterdog/context-parts.test.ts server/laterdog/chat-context-breakdowns.test.ts \
  server/laterdog/engine-context-ask.test.ts server/laterdog/context-tool-sizes.test.ts \
  server/routes/chat-context.test.ts server/testing/fake-claude-context.test.ts \
  server/laterdog/chat-context.e2e.test.ts shared/context-breakdown.test.ts src/components/ChatContextBreakdown.test.ts
```

The fake engine (`server/testing/fake-claude-cli.ts`) answers the request in three ways, chosen by
`FAKE_CLAUDE_CONTEXT`: `answers` (default), `unknown` (an older engine) and `no-turn`. In `answers` mode it
answers the two details the way the real engine does: `summary` is a fixed rough total with no `messages` part,
`full` is the size of the turn's real request with `messages` as the remainder. `FAKE_CLAUDE_CONTEXT_FOLLOWS_TURNS=1`
makes each turn's reported usage equal that real request size, so a test can compare the count with the chat's own.
`FAKE_CLAUDE_CONTEXT_SEEN` names a file where the fake writes one line per request it receives.
The fixture test runs a real home on the fake engine. It reads the breakdown back after a turn, checks that an
older engine is asked once, and checks that deleting a dog removes its chats from `context-breakdowns.json`.

## Seen on a real engine

Run on 2026-11-14 by the coordinator, with Claude Code 2.1.316 started the way the home starts it (print mode,
JSON lines on both streams), in an empty folder with an empty config, no prompt and no `initialize` request:

- `get_context_usage` with `detail: "summary"` was answered with `success` 0.4 s after start, before any turn.
  In this mode there is no "no turn yet" refusal and no `initialize` is needed.
- The answer had `totalTokens` 34,287, `maxTokens` 1,000,000 and `autoCompactThreshold` 967,000 with
  auto-compaction on. Its categories were `system_prompt` 2,228, `system_tools` 29,893,
  `system_tools_deferred` 19,391 (deferred), `skills` 2,166, `autocompact_buffer` 33,000 and
  `free_space` 932,713. The used parts added up to the total exactly, and the window's parts to `maxTokens`.
  There was no `messages` category before a turn, so a missing category is normal.
- The answer also carried `memoryFiles`, `mcpTools`, `mcpInstructions`, `agents`, `slashCommands`, `skills`,
  `messageBreakdown`, `gridRows`, `model` and `apiUsage`. The home keeps none of these.
- With the request written and stdin closed 5 ms later, the engine still answered and exited with code 0 half a
  second later, so a waiting request does not hold the engine open.

## Seen on a real engine, summary against full, 2026-11-14

Run by the coordinator with Claude Code 2.1.316, signed in, on two models, one question of each detail before a
turn and after each of two turns. The chat's own number is the input, cache-read and cache-write tokens of the
turn's last request, which is what the home already counts.

- `detail: "summary"` is a fixed rough estimate that does not follow the conversation. On the smallest model its
  total was 49,116 before a turn, then 50,393 and 50,180 after two turns, while the real requests were 32,576 and
  32,996 tokens (52 to 55% too high); its `messages` part was 260, then 42. On a mid-size model it was 36,314, then
  37,316 and 37,316, with no `messages` part, while the real requests were 31,045 and 32,124 (16 to 20% too high).
- `detail: "full"` follows reality. On the smallest model it gave 32,846 and 32,996 against real 32,580 and 32,941
  (0.8% and 0.2% above). On the mid-size model it gave 31,044 and 32,141 against real 31,044 and 32,141 (exact).
  Its `messages` part grew with the conversation (4,888, then 5,985). Answers came 0.00 to 0.15 s after the turn
  ended. Category ids matched the summary's, plus extra keys the home does not read.
- The home therefore asks for `full`. It reads `maxTokens`, `totalTokens`, `autoCompactThreshold`,
  `isAutoCompactEnabled` and each category's id, name, kind, deferred flag and tokens, and keeps only sizes.
- On the smallest model the engine's total sits slightly above the chat's number because it adds its own estimate of
  the last reply. A total above the chat's number is therefore not out of date by itself; only a total more than 2%
  below it is, which is what an engine that has not loaded the conversation yet reports.
- The fake engine now answers both details this way, and `server/laterdog/chat-context.e2e.test.ts` fails if the
  home asks for `summary`: the count it reads back after a turn would not be within 2% of the chat's own number.

## Not yet proven

- An answer after a real turn with later.dog's own tools loaded (`mcp_tools`) on an isolated home; the runs above
  had none.
- A full count on the largest models and on a conversation of several hundred thousand tokens: how long it takes
  there, since the home gives up after 5 seconds and falls back to its own estimate.
- A count right after the engine compacts a conversation, and right after a lost conversation is rebuilt.
- The Codex and included-model estimates against a real engine. Only the home's own sizes are counted there;
  the rest of the engine's total is shown as "Conversation and the AI's own setup".
- The phone app.
