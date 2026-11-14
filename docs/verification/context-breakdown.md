# What fills a chat's context window

A chat's Usage panel shows a row headed This chat, which gives the chat's current number ("31.3k of 200k · 16%").
Opened, the row lists what fills the window, largest first. Tools the engine can load on demand are listed
apart, without a share. A Claude Code chat shows the engine's own count. A Codex or included-model chat shows
the home's estimate, marked "about". When the parts were taken before the chat's last turn, or are more than 2%
off its number, the row says "as of …" even while closed, and the bar shows only the current number.

## Contract

`GET /api/threads/:threadId/context`. It has the same scope as `/api/threads/:id/messages`, but the dogs' own
service connection cannot read it.

- 200: `{ at, source: "engine" | "estimate", total, window, parts: [{ id, tokens, deferred? }], compactsAt?, stale? }`
- `id` is one of: `conversation`, `tools`, `instructions`, `skills`, `memory`, `helpers`, `other`, `reserve`, `free`.
  Tools not loaded yet come as `{ id: "tools", deferred: true }` and sit outside the window.
- `stale: true` means the parts are older than the chat's last turn, or more than 2% off the chat's own number.
  The app shows the chat's own number (`usage.context`) in the heading and bar, and the parts only in the list.
- 404 `{ error: "nothing yet" }`: no count yet. 404 `{ error: "no such conversation" }`: not a dog's chat.
  A home without this route answers 404 too, and the app keeps the older single-number row.
- Sizes only: never conversation text, file paths, tool names or model names.

The home asks the engine with one stdin line,
`{"type":"control_request","request_id":"laterdog-context-…","request":{"subtype":"get_context_usage","detail":"summary"}}`.
It asks after every turn and when the view opens. An engine that answers "Unsupported control request subtype"
is not asked again in that session. An engine that stays silent twice in a row is not asked again either, but a
late answer clears that count.

## Run on fixtures

```sh
pnpm exec vitest run server/laterdog/context-parts.test.ts server/laterdog/chat-context-breakdowns.test.ts \
  server/laterdog/engine-context-ask.test.ts server/laterdog/context-tool-sizes.test.ts \
  server/routes/chat-context.test.ts server/testing/fake-claude-context.test.ts \
  server/laterdog/chat-context.e2e.test.ts shared/context-breakdown.test.ts src/components/ChatContextBreakdown.test.ts
```

The fake engine (`server/testing/fake-claude-cli.ts`) answers the request in three ways, chosen by
`FAKE_CLAUDE_CONTEXT`: `answers` (default), `unknown` (an older engine) and `no-turn`.
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

## Not yet proven

- An answer after a real turn with later.dog's own tools loaded, on an isolated home.
- The Codex and included-model estimates against a real engine. Only the home's own sizes are counted there;
  the rest of the engine's total is shown as "Conversation and the AI's own setup".
- The phone app.
