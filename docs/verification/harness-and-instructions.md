# Harness tuning and what dogs are told

Changes to how a dog's turn is put together, and what has and has not been
proven about them.

## The changes

1. **Only changed context is re-sent.** A dog's changing context (the
   `today`, `recent`, `memory`, `mentions`, `outstanding`, `availability` and
   `connected` sections in `server/system-prompt.ts`) is split into sections.
   `connected` says whether GitHub is signed in on the home and whether a Mac
   is lent right now, so the standing instructions stay byte-identical when a
   Mac connects or disconnects. The home
   sends every section on a new or rebuilt session and afterwards only the
   sections that changed. A Claude session sends everything again after a
   compaction; a Codex dog does the same once Codex reports a
   `contextCompaction` item (`forgetDeliveredContext` in
   `server/drivers/codex-instructions.ts`).
2. **A setting for the model helpers use.** A dog's `helperModel` lets its
   helpers run on a lighter Claude model than the dog itself.
3. **Rare tools on demand, off by default.** With
   `LATERDOG_DEFER_RARE_TOOLS=1`, later.dog's rarely used tools
   (`RARE_AGENT_TOOLS` in `server/laterdog/tool-loading.ts`) are loaded only
   when a Claude dog searches for them. Without the setting every tool is
   loaded, as before. Rules a dog must always follow stay in its standing
   instructions rather than only in a deferred tool's description: the rule
   against opening Google's consent page is in `GOOGLE_PROMPT`.

4. **The engine compacts its own chat.** For Claude Code and Codex dogs
   later.dog no longer folds a chat at 80% of the model window and starts the
   engine cold; the engine compacts at its own default and keeps its session
   (`harnessCompacts` in `server/laterdog/native-compaction.ts`). Claude Code
   2.1.311 and later already launch with `--autocompact auto`; later.dog sets
   neither `model_auto_compact_token_limit` nor `model_context_window` for
   Codex, so Codex uses the limit from its own model catalog. later.dog still
   summarises the older part once when it has to start a new session that
   cannot hold the whole chat: an account switch, an engine switch, an edit
   to an older message. A Codex `contextCompaction` item now shows the same
   "Compacting the conversation" row as Claude. Engines without their own
   compaction keep later.dog's fold, and so does any chat where the engine
   gives no sign it will compact: one rule, `engineWillCompact` in
   `server/laterdog/native-compaction.ts`, leaves a chat to the engine only
   for Claude Code without `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT` or (with
   the person's own settings inherited) `autoCompactEnabled: false`, and for
   Codex outside a company install on a model its catalog lists. The server
   setting `context.harnessCompaction: false` in config.json brings back the
   old fold for Claude and Codex too; it is on by default.
   Every rebuild that drops part of the chat, including one the engine forces
   mid-turn by refusing a saved session, now carries a summary of what was
   dropped (`server/laterdog/rebuild-summary.ts`). For Claude Code 2.1.316 and
   later that is Claude's own compaction summary, which its `PostCompact` hook
   hands over (`compact_summary`, read in the bundled hook schema) and later.dog
   keeps per chat in `engine-summaries.json`; anything newer than that summary
   is added as excerpts of the person's oldest and newest messages, made
   without a model call. Codex 0.167.2 hands back no text: its
   `ContextCompactionItem` carries only an id, so Codex chats get the excerpts.
5. **Recall when a session starts.** A Claude or Codex dog gets the automatic
   recalled passages on the first turn of a new or rebuilt session only;
   afterwards the dog searches with the tools it already has. Engines that
   replay the chat themselves still get recall on every turn
   (`server/laterdog/session-start-recall.ts`).
6. **The hour-long cache only where it is free.** later.dog sets
   `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` only for a subscription account on a
   Claude Code older than 2.1.316. From 2.1.316 Claude Code picks the lifetime
   itself (an hour on a subscription within its limits, five minutes on an API
   key, per its settings schema), and an account that pays per token for cache
   writes (an API key or auth token in the environment or in the account's own
   settings, an `apiKeyHelper`, or a cloud provider's endpoint) is left to
   Claude Code (`server/laterdog/cache-lifetime.ts`).
7. **Left as they were, with the reason.** The skills index stays in the
   standing instructions: the native skill links live in the dog's workspace
   (`server/skills.ts`), but the engine runs in the chat's own folder under
   `task-workspaces`, so neither engine finds them there. The on-it note stays
   on every person's message: it was added because a dog with the rule only in
   its instructions kept copying how it behaved earlier in a long chat.

Flags and settings were read from the installed tools on 2026-11-13: Claude
Code 2.1.316 (`claude --help`: `--autocompact <auto|tokens>`; the bundled
settings schema: `autoCompactWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
`DISABLE_AUTO_COMPACT`, `promptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL`) and
Codex CLI 0.167.2 (config keys `model_auto_compact_token_limit`,
`model_context_window`, the `contextCompaction` item).

## Numbers from the measuring scripts

Both scripts run on an invented fixture home and estimate tokens as bytes / 4.

```sh
TMPDIR=<scratch> node --experimental-strip-types scripts/measure-volatile-notes.ts
TMPDIR=<scratch> node --experimental-strip-types scripts/measure-dog-prompt.ts
```

- `measure-volatile-notes.ts` (a 100-turn main-dog chat; recent work changes
  every 10 turns, memory every 25, the date never): re-sending the whole
  changing context would send 104,124 bytes (about 26,031 tokens) over 100
  turns; sending only changed sections sends 35,382 bytes (about 8,846
  tokens), **66.0% less**. The standing part stayed byte-identical across all
  100 turns.
- `measure-dog-prompt.ts`, against `scripts/dog-prompt-baseline.json` (the
  instructions before they were rewritten): the standing instructions grew from
  20,051 to 22,661 bytes for a main Claude dog (+13.0%) and to 21,991 bytes for
  a main Codex dog (+9.7%); across main, helper, group and handed-over dogs the
  growth is 9.5% to 17.9%. Counting the first context note too, a fresh dog's
  first request is 6.1% to 12.8% larger.

`scripts/measure-turn-extras.ts` measures the second pass on the same kind of
fixture (40 person turns, sessions started at turns 1 and 21):

- Compaction: before, later.dog folded a Claude chat at 160,000 tokens on a
  200K window (the "161k" the owner saw), at 800,000 on a 1M window and a Codex
  chat at 217,600 of 272,000, each fold starting the engine cold. Now the
  engine compacts at its own default; later.dog summarises only to rebuild.
  In the fixture tests a Claude chat at 190,000 of 200,000 tokens and a Codex
  chat at 250,000 of 272,000 keep their sessions with no later.dog summary
  (`server/laterdog/native-compaction.e2e.test.ts`).
- Auto-recall: up to 3,005 bytes per person turn in this fixture (the cap is
  6,000 characters). Over 40 turns it added 120,200 bytes to the chat's
  history before and 6,010 bytes now; the last request carried about 15,025
  tokens of recalled text before and about 752 now.
- A refused resume of an 801,524-byte chat (389 messages dropped): the rebuild
  was 22,477 bytes with no summary and lost the oldest decision; it is now
  28,371 bytes and keeps it.
- Cache lifetime: on an API key account a cold start at 60,000 tokens is billed
  as about 120,000 token-equivalents with a forced hour and 75,000 with five
  minutes (write prices of 2x and 1.25x the input price, from public pricing,
  not measured). Subscriptions are unchanged.
- Skills index: 2,805 bytes (about 702 tokens) for 12 skills, unchanged.
- On-it note: 290 bytes per person turn, 11,600 bytes over 40 turns, unchanged.

## Live numbers, 2026-11-12, on a real Claude model

- A fresh dog's first request carried 41,165 input tokens with every tool
  loaded and 30,768 with rare tools on demand.
- Ten turns of one dog used 1.38 million input tokens, 87% of them served from
  the cache.
- A tool loaded on demand was still found and used.

## Seen with a real engine, 2026-11-13

An isolated local server ran one test dog on Claude Code 2.1.316 with a small
Claude model, and with the engine's compaction set to 100,000 tokens so that it
happened within a few turns.

- **On the code before the second pass** (`7076fb394`): after the chat's saved
  session was moved away, the next message failed in 1.6 seconds with no reply
  and no row in the chat. The engine answers a resume of a session it no longer
  has with an error result, which the driver did not recognise.
- **The engine's own compaction** (branch at `4be2f729d`): while the dog read
  three 68 KB files the engine compacted twice mid-turn and carried on, the
  home received the engine's summary both times, and the dog then quoted the
  first line of the first file correctly.
- **A lost session after the fix** (branch at `d0006e924`): after two engine
  compactions the server was stopped and the session file moved away. The next
  message was answered 5.2 seconds after sending, with a fact given only in the
  chat and the first line of the first file both right.

The commits after `d0006e924` (the plain pick-up line, and showing the dog as
working while it rebuilds) were checked on fixtures only.

## Not proven

- Compaction at the engine's own default window, on a large model or on a real
  home; how good the summaries are over a long chat; whether a dog still finds
  old facts through search without per-turn recall; and the cache lifetime
  Claude Code picks on a real account.
- Codex compaction on a real engine: the reset is covered only by a unit test
  (`server/drivers/codex-instructions.test.ts`), with no live compaction.
- Tools on demand on the smallest Claude model or with a custom endpoint.
- Every claim in the dogs' instructions checked against a real home, such as
  what the kit line says a dog already has.
