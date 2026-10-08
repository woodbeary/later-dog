---
name: verify-laterdog
description: "Prove later.dog's workspace delegation, durable supervisor, remote publishing and conversation recovery on its own isolated fixtures, keeping the evidence and naming the limits."
---

# Verify later.dog

Use after changing the supervisor, its MCP tools, the Cloud jobs screen or the hand-off back to a conversation, before saying the change works. Node 24 and pnpm. Other server and conversation changes follow `docs/verification/README.md`.

## Procedure

1. **Check the checkout:** `pnpm typecheck` and `pnpm lint`.
2. **Run the fixtures:** `pnpm laterdog:test`. It starts its own HTTP server, SQLite store, Git repositories, React render and a disposable later.dog server on the fake engine. It never submits a real cloud task or opens a real pull request. Its conversation round trip checks that server with `control-laterdog doctor` first, then leaves `receipts.json` and `server.log` in `.laterdog-evidence/conversation/` (and `conversation-pull/` for the hosted wake-up path).
3. **See it in the app.** `node scripts/laterdog-preview.mjs` prints a JSON line with `previewUrl`. Open it with the browser automation your client has, open **Cloud jobs** in the sidebar (Settings → Advanced mode shows it), connect repository `fixture/preview` with environment ID `synthetic-environment`, delegate one narrow task, and follow the job's **Conversation** link back to the chat that asked. The job should stay queued: the preview's scheduler is off and no provider is called, so a queued synthetic job is the expected result. Save screenshots in `.laterdog-evidence/preview/`, showing the scope, the job's identity, its receipts and the conversation it returned to.
4. **Stop what you started:** Ctrl-C the preview process, and only that one. It copies its server log to `.laterdog-evidence/preview/server.log`, closes its servers and deletes its temporary data. Then check that the evidence is still there.

## What this does not prove

Fixture success does not qualify a live provider. Codex Cloud and Claude cloud compatibility, real GitHub access, the hosted supervisor, a signed macOS build and throughput are qualified only by the live checklist in `docs/laterdog/verification.md`. Per-feature recipes and their limits: [features/README.md](features/README.md).
