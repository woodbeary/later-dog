# Conversation context compaction

Long direct conversations can summarize older exchanges before the next turn.
The full transcript, its branches and attachments are retained. The new session
gets a bounded summary plus recent exchanges; later turns resume that session.
A visible, expandable note explains what was summarized, even with tool chips off.

## Exercise the real path

```sh
pnpm exec vitest run server/context-compaction.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/compaction-summary.test.ts server/context-budget.test.ts server/delta-context.e2e.test.ts
pnpm exec vitest run server/store.test.ts server/config.test.ts src/components/DigestChip.test.ts
pnpm test:packaged-server
```

The API fixture launches the shared isolated server and fake engine. It uses
`control-laterdog` for create, send, wait, edit and Stop. Its new manual operation is
`POST /api/bots/:id/compact` with `{ "threadId": "owned-thread-id" }`; this uses
normal turn admission, returns 202, and completes through that thread's ordinary
busy/idle state. The route accepts no agent-written summary or file path.
There is not yet a dedicated manual-compaction button in the app.

Evidence covers:

- Automatic compaction keeps the two latest exchanges and the incoming request.
- A completed turn retains the driver's latest-prompt measurement, separately from summed input tokens.
- Claude compaction leaves headroom before the selected account's numeric native threshold, including after a previous compaction; `auto` and `off` do not invent a numeric native limit.
- Manual compaction executes no additional agent turn and retains the original messages.
- A repeated request at the same compacted tip is a no-op.
- Restart before the next send retains the summary and replaces the native session once.
- A later send keeps that replacement session instead of injecting the summary again.
- Editing an old message replays its selected branch, not the abandoned summary.
- Stop aborts a hanging helper without a late record; a new send still works.
- Private session bookkeeping stays off the task wire shape; stored summaries redact secrets.

Each API fixture retains exact requests, waits and bounded transcripts in
`<server-log>.context.json`, prints that location, and closes its exact child and
temporary home. No live account, computer or user workspace is touched.

## Bounds and limitations

`context` settings in config.json are optional. `autoCompact: false` disables
automatic folding, `compactAt` is a fraction below 1 or a token count, and
`rebuildBytes` controls replay size (default 24,000 bytes). Context-only settings
do not reload provider processes. The default threshold is 80% of the known
model window; a real latest-prompt measurement wins over a transcript estimate.
Summed input tokens across tool rounds are never treated as context size.
For Claude, the threshold and post-compaction regrowth floor also leave 10%
headroom below the selected account's numeric native-compaction setting.
That account's setting takes precedence over the inherited launch environment.
Native `auto`/`off` settings supply no known numeric bound; other engines keep
their own model-window threshold. The native CLI setting itself is unchanged.

The selected account's tool-free helper can produce a historical summary, with
a 20-second timeout and source-labelled fallback when unavailable. Summaries
are capped at 6,000 bytes and retain recent source corrections. The helper may
incur provider usage; its one-shot cost is not separately reported by the current
provider interface. Summaries are not verified facts and can omit details.

This slice covers direct threads. It does not add channel compaction, change
provider-native compaction, prove live-model summary quality, or ship native
iOS/Android compaction controls. The renderer test checks note markup and escaping,
not a real browser click. Native mobile indicators remain separate PR work.

## The engine's own compaction

Claude also compacts its own session when it nears its native limit. That shows
live as one activity row in the turn that caused it: "Compacting the conversation"
while it runs, which is also the working line, then "Compacted the conversation in
42 seconds" with the tokens before and after and how many digests were re-sent, or
"Couldn't compact the conversation" with the engine's reason, secrets redacted.

```sh
pnpm exec vitest run server/laterdog/compaction-live.test.ts server/drivers/claude-compaction.test.ts server/thread-events.test.ts
pnpm exec vitest run server/drivers/claude.test.ts -t "compacting"
pnpm exec vitest run server/hooks.e2e.test.ts -t "compaction"
```

The engine's stream (the repeating `compacting` status, its result and the
boundary with token counts) and its `PreCompact` and `SessionStart` hooks report
the same compaction; whichever arrives first opens the row and the rest fill it
in, in either order. A compaction skipped before it started adds no row. A row
still open when the server stops is closed as stopped on the next start, from
`compactions-open.json` in the data folder (mode 0600). Rows carry the request
they belong to and stay out of restart pickups, status lines, digests and the
memory log. The stream shapes match Claude CLI 2.1.301; other engines report
nothing new.
