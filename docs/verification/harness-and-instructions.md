# Harness tuning and what dogs are told

Three changes to how a dog's turn is put together, and what has and has not been
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
  20,051 to 22,570 bytes for a main Claude dog (+12.6%) and to 21,902 bytes for
  a main Codex dog (+9.2%); across main, helper, group and handed-over dogs the
  growth is 9.0% to 17.4%. Counting the first context note too, a fresh dog's
  first request is 5.8% to 12.4% larger.

## Live numbers, 2026-11-12, on a real Claude model

- A fresh dog's first request carried 41,165 input tokens with every tool
  loaded and 30,768 with rare tools on demand.
- Ten turns of one dog used 1.38 million input tokens, 87% of them served from
  the cache.
- A tool loaded on demand was still found and used.

## Not proven

- Codex compaction on a real engine: the reset is covered only by a unit test
  (`server/drivers/codex-instructions.test.ts`), with no live compaction.
- Tools on demand on the smallest Claude model or with a custom endpoint.
- Every claim in the dogs' instructions checked against a real home, such as
  what the kit line says a dog already has.
