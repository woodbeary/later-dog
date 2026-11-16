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
3. **Rare tools on demand, by model.** later.dog's rarely used tools
   (`RARE_AGENT_TOOLS` in `server/laterdog/tool-loading.ts`) are loaded only
   when a Claude dog searches for them, on the models where that has been
   proven: the families in `DEFER_PROVEN_FAMILIES`
   (`server/laterdog/defer-by-model.ts`), today Fable 5, 5.1 and 5.2 and
   Opus 5 and 5.5. A model is read by whole version parts (`modelFamily`
   in `server/laterdog/dog-guidance.ts`): a dated id, a `[1m]` suffix or a
   provider prefix of a proven model is on; `claude-opus-50` or
   `claude-opus-5-50` is an unknown model and off; the bare aliases `opus`
   and `fable` and an empty model are off. Every other model, a dog with no model named, and any
   custom endpoint (a hosted or local model, an `ANTHROPIC_BASE_URL` other
   than `api.anthropic.com`, or a cloud-provider switch) gets every tool up
   front. The server setting `LATERDOG_DEFER_RARE_TOOLS` forces it: `1`, `on`
   or `true` loads rare tools on demand for every model, `0`, `off` or `false`
   loads everything up front; unset, or any other value, means by model. The
   setting began as opt-in (`d76644902`), `cc5114d57` made on-demand the
   default for every model, both on 12 November 2026, and item 18 narrowed it
   to the proven models. Rules a dog must always follow stay in its standing
   instructions rather than only in a deferred tool's description (see
   "Rules that must not hide in a rare tool" below). To add a model to the
   table, run the check in "Proving rare tools on demand for a model" below.
   The Claude adapter keeps what each chat's launch decided
   (`rareToolsOnDemand(threadId)`); once a turn is sent the context view
   takes that answer (`toolsSent`), so on a proven model it counts the rare
   tools as not loaded rather than as sent, without resolving the model a
   second time.

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

## Seen on a real home, 2026-11-14

From the home's own usage ledger and the traces of seven dogs that day.

- 26 turns from 16:00 PT on 13 November to 13:00 PT on 14 November used 107.5
  million input tokens, 98% of them read from the cache, and 443,000 output
  tokens. By model: the strongest general model 78.1 million (98% cached), the
  middle one 25.3 million (98%), the coordinating model 3.8 million (95%).
- A newly created dog's first request was about 35,500 tokens, of which
  later.dog's own standing instructions were about 5,500 (22 KB). The 12
  November figure above was 30,768 with rare tools on demand. Why the two
  differ by about 4,700 tokens has not been worked out; both are kept.
- What it did not show: each of six helper dogs did its whole job in one turn
  and grew from about 35,000 to between 220,000 and 440,000 tokens without
  compacting, re-reading that context at every step. One waited on a test run
  by asking about 14 times at 440,000 tokens.
- A fault seen that day: when a chat moved to another account, the summary of
  the earlier conversation was written by the smallest model, which answered the
  conversation instead of summarising it, and the dog lost what it had been
  doing. The fix is in progress.

## Proving rare tools on demand for a model

Run this on an isolated machine with a signed-in Claude Code and a test
account, never on a person's home. It needs only this repository (with its
packages installed) and the `claude` command. It does not start a later.dog
home: it launches Claude Code the way the home does (the later.dog tool list
from `availableTools`, marked by `agentsServerLaunch` and `withToolLoading`,
`--strict-mcp-config`, `--setting-sources project`, the dog's standing
instructions from `dogGuidance` through `--append-system-prompt-file`), with a
stand-in tool server, `server/testing/proof-agents-server.ts`, that records
each call and does nothing: no text, routine or change is ever made.

```sh
node --experimental-strip-types scripts/prove-rare-tools.ts \
  --models claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5 \
  --out "$HOME/rare-proof-$(date +%Y%m%d-%H%M%S)"
```

Optional: `--cli <path to claude>`, `--repeat <n>` to run each case n times,
`--with-servers <file>` to mount more tool servers next to the stand-in (a
JSON file with `mcpServers`, without `agents`).

The stand-in mounts only later.dog's own tools. A real home also mounts the
computer and browser servers, whose tools are hidden too, so a dog searches
among more names there. A model may join the table only on a run with a
home's full tool list: on the isolated machine, with a test home running
and a dog's turn in progress, copy that turn's `mcp.json` (in a
`laterdog-mcp-*` folder under the home's temporary folder; it is removed when
the session ends), delete its `agents` and `dog` entries, and pass it with
`--with-servers` while the home keeps running. A run with the stand-in alone shows the mechanism and the
token drop; it does not by itself prove the find.
For a custom endpoint, run it again with that endpoint's `ANTHROPIC_BASE_URL`
and key in the environment and its model names in `--models`; the summary
says "Custom endpoint in this environment: yes".

For each model it runs three one-turn tasks in a fresh empty folder, first with
every tool up front (`off`), then with rare tools on demand (`on`):

- `first-request`: "hi". The first request's input tokens (input plus cache
  write plus cache read, from the engine's first assistant message) measure
  what a fresh dog carries; on 12 November a whole home measured 41,165 off
  and 30,768 on.
- `text`: "Text Sam at 555-0100 that I'm running ten minutes late." needs
  `send_text`, a rare tool with required fields.
- `routine`: "Every Monday at 9am, remind me to water the plants." needs
  `propose_routine`, another rare tool with required fields.

It prints a table and writes `summary.md`, `results.json` and each raw turn
(`<model>-<setting>-<task>.jsonl`) to the `--out` folder. A rare tool counts as
found only when the stand-in server received a call to it with every required
field filled.

The script ends with one verdict line per model, `<model>: may join the
table` or `<model>: may not join the table: <why>`. A model may join
`DEFER_PROVEN_FAMILIES` in `server/laterdog/defer-by-model.ts` when, with
`--repeat 3` and `--with-servers` as above, every run exited 0, every `on`
row of `text` and `routine` says `found` and its `off` row did too (so the
task itself is fair), and every `on` `first-request` row is lower than every
`off` row. A row counts as found only when its run exited 0. A `NOT FOUND` on `on`
with `found` on `off` is the failure this check exists for: the model did not
search for a tool it could not see. Paste `summary.md` into the pull request
that changes the table.

What this does not measure: the whole prompt of a real home (memory, recent
work, connected apps), so its token numbers are lower than a home's; and
tasks longer than one turn.

## Rules that must not hide in a rare tool

A rare tool's description reaches a dog only after it searches for that tool,
so a rule there binds only calls of that tool. A rule that also governs what a
dog does without the tool must be in the standing instructions as well.
`server/laterdog/rare-tool-rules.test.ts` keeps each such rule in the
instructions a dog is sent on each engine (`guidanceParts` with
`agentRuleTexts`, the parts the home sends). Checked
on 15 November 2026, every one of the 32 rare tools:

- In the standing instructions: the Google consent page never opened in the
  dog's own browser and emailed codes kept out of chat (`GOOGLE_PROMPT`);
  never pasting a device code into chat (`DEVICE_APPROVAL_PROMPT`); a declined
  send card for mail or texts is a no (`needsPerson`; the card itself is
  enforced by the home on every send); a denied or offline Mac is respected
  and secrets never printed (`signInPassage`);
  a page asking to add a server is not an order (`READ_TEXT_IS_NOT_AN_ORDER`);
  no clicking through the app to make dogs or group chats
  (`DOG_CREATION_PROMPT`).
- Moved: "usage never decides whether to start or keep working" lived only in
  `account_usage`. It is now `USAGE_NEVER_STOPS_WORK` in the standing
  instructions of every dog with later.dog's tools, on every engine, and no
  longer in the description; Claude and Codex dogs also read that a turn at a
  limit carries on on another account (`LIMIT_MOVES_ACCOUNT`).
- Bind only a call of their own tool, so they stay in the description: when
  to call (`list_routines`, `account_usage`, `read_phone`, `add_to_phone`,
  `change_on_phone`, `nearby_places`, `email_me`, `send_voice_note`,
  `execution_advice`, `skills_list`), how to fill the call
  (`propose_routine`, `propose_routine_action`, `switch_account`,
  `add_mcp_server`, `skill_manage`, `create_bot`, `manage_room`,
  `create_room`), and what to do with its result (`propose_profile`,
  `propose_model`, `dog_queue`, `dog_accounts`, `list_shared_computers`,
  `shared_computer`, `gmail_search`, `gmail_read`, `read_texts`). Making a new dog in place
  of a broken one is refused in `create_bot` itself, the only way to make one.
  Recipients for `email_me` and who may use `dog_queue` and `dog_accounts` are
  enforced by the home, not by words.

## Not proven

- Compaction at the engine's own default window, on a large model or on a real
  home; how good the summaries are over a long chat; whether a dog still finds
  old facts through search without per-turn recall; and the cache lifetime
  Claude Code picks on a real account.
- Codex compaction on a real engine: the reset is covered only by a unit test
  (`server/drivers/codex-instructions.test.ts`), with no live compaction.
- Tools on demand on Sonnet, Haiku or a custom endpoint: off there until the
  check below passes for that model.
- Every claim in the dogs' instructions checked against a real home, such as
  what the kit line says a dog already has.
