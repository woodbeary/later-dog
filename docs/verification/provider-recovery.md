# Provider images, authentication and approval grants

Every command below uses a disposable home. No real account, API key,
provider charge, deployment, or running later.dog workspace is involved.

## Real CLI transport checks

Pass the path to an already installed CLI. These checks never update it.

```sh
node --experimental-strip-types scripts/verify-grok-images.ts /absolute/path/to/grok
node --experimental-strip-types scripts/verify-claude-auth-settings.ts /absolute/path/to/claude
node --experimental-strip-types scripts/verify-claude-auth-settings.ts /absolute/path/to/claude --api-key
```

- Grok must deliver the **exact** synthetic PNG bytes to a loopback model.
  Grok 1.0.25 advertises `image:false` despite accepting native ACP image
  blocks. later.dog enables that verified compatibility path only for official
  1.0.x runtimes from 1.0.25 onward; other runtimes must negotiate image
  input normally. The fixture uses a valid 32×32 PNG because Grok rejects
  images below 8 pixels per axis or 512 total pixels.
- Claude must complete **two** turns using the selected account's personal
  `apiKeyHelper`, and again with `settings.json`'s API key. All authenticated
  model requests go to the fake local Anthropic endpoint. An unrelated
  personal SessionStart hook must not run. later.dog retains project settings but
  projects only account authentication from personal settings. Explicit later.dog
  credentials/endpoints take precedence as a pair.
These prove transport/auth integration, not hosted image interpretation,
subscription entitlement, Console-profile availability, or production API
uptime. If Claude still reports signed out, compare its `/status` Profile
and the account selected in later.dog; never request the user's keys or tokens.

## ACP internal-error recovery

```sh
pnpm exec vitest run server/drivers/acp/acp.test.ts server/acp-recovery.e2e.test.ts server/resume-recovery.test.ts server/delta-context.test.ts server/incidents.test.ts server/room-coordination.e2e.test.ts
```

The ACP transport fixture injects an internal RPC error, including one after
partial output. The failed turn completes once without automatically resending
it. The failed process is retired; a subsequent explicit turn resumes the durable
session on a fresh process and can complete in the same later.dog thread. Where a
native session can no longer be loaded, the replacement receives the canonical
conversation history rather than only the latest message.

The server-level fixture uses a disposable verification workspace and the fake
ACP executable. It checks that an RPC failure releases the busy state, preserves
the thread's transcript, and allows another message without deleting the bot or
thread. The coordination fixture separately checks failed peer completion.

These checks establish recovery behavior, not the cause of a particular user's
provider outage. A generic ACP `-32603` service error can cover directory,
configuration, session, or upstream API failures. Its presence alone does not
prove that a working-folder path is wrong, and restarting cannot repair a
persistently invalid account or provider configuration.

## Isolated server and private grants

```sh
pnpm exec electron scripts/smoke-approval-modes.cjs
```

The real server runs under Electron's private utility-process channel with
fake Claude, Codex and Grok providers. Approval levels are chosen in a dog's
settings; the composer has no approval menu. Assertions cover:

- Direct HTTP elevation is rejected; the private desktop channel applies
  Full, Auto, Auto-accept edits and Ask, and each resumed Claude turn uses the
  matching native permission mode.
- Full for all threads includes archived and future threads and leaves other
  dogs alone; it is refused while a turn is active.
- Applying the dog's level to an existing thread needs that level chosen in
  the dog's settings first, and the thread must use the dog's provider.
  Unknown threads are rejected. Unrelated threads stay Ask.
- Custom is available only for Codex. Delegated Codex Custom work uses the
  native Auto reviewer and still shows its card.
- Grok Auto answers reviewed reads without duplicate app cards, while
  deletion, credential, spoofed-title and question requests stay interactive.

Provider processes are fakes. The fixture exits and removes its own
disposable server data.

## Regression checks

```sh
pnpm exec vitest run server/drivers/acp/acp.test.ts server/drivers/claude.test.ts server/drivers/claude-auth.test.ts server/drivers/codex.test.ts server/drivers/retry.test.ts server/store.test.ts src/components/ChatView.controls.test.ts
node --test electron/approval-trusted-mode.node-test.mjs
pnpm typecheck
pnpm lint
```

The tests also cover image-byte redaction, unknown ACP runtimes, private
authentication-file permissions and cleanup, explicit credential precedence,
authentication rotation on retained sessions, crash recovery at every grant
phase, and safety failures delivered as RPC errors or completion events.

Codex safety monitoring is independent of tool approval settings. This change
preserves the actual provider error, prevents automatic replay, and explains
the distinction; it does **not** bypass provider safety or claim to fix an
unseen deployment refusal. See the [official Codex safety guidance](https://learn.chatgpt.com/docs/agent-approvals-security#safety-monitoring-and-paused-tasks).

Grok's upstream image ingestion is in [its ACP prompt builder](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/acp_session_impl/prompt_build.rs).
Claude's account settings are documented in [Claude Code settings](https://code.claude.com/docs/en/settings).
