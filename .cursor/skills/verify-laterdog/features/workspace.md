# Delegating work from a conversation

**What it is.** A dog hands a scoped task on a connected repository to a cloud account profile. The job gets a durable identity and receipts, and when it settles, the result comes back to the conversation that asked.

**Where a person finds it.** Sidebar → Cloud jobs → Connect repository, then Delegate work. A job's details link back to its Conversation.

**Prove it.**
- `pnpm laterdog:test`: delegation runs MCP → authenticated HTTP → SQLite and one request identity makes one job (`server/laterdog/http.test.ts`); a disposable later.dog server on the fake engine receives the completion in the right dog's thread exactly once (`server/laterdog/workspace.e2e.test.ts`).
- In a browser: `node scripts/laterdog-preview.mjs`, connect `fixture/preview` with environment ID `synthetic-environment`, delegate a task scoped to `src/components`, check its own output branch and its first receipt, then follow Conversation back to the same dog and thread.

**Not proven here.** The preview never runs its scheduler or submits cloud work. A missing supervisor is a failure to report, not an empty workspace. An environment's generation label records what has been qualified; it does not make the environment compatible.
