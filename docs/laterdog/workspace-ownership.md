# Attach the existing workspace to the account

## Product decision

The existing Mac workspace is canonical: coordinator, main desk, minor changes, main app, REA, refactor main desk, and their conversations. Account sign-in attaches that workspace to the account. Desktop and phone open the same dogs and chats automatically. Local storage, synchronization and cloud execution are managed behind the scenes. The normal interface has one workspace and no server selector, including no This computer/My Cloud choice in the sidebar. A workspace name or account identity may be shown without becoming a connection picker.

The existing Ember, Willow and Finch cloud workspace is retained separately. This plan does not authorize deleting it, overwriting it, or merging its records into the canonical workspace. Its recovery path belongs in advanced account recovery or developer diagnostics, outside the sidebar and ordinary navigation. It must never become a second default workspace after sign-in or reconnect.

This document is a proposal for review before substantial implementation. Only the immediate sign-in fix has been implemented.

## Immediate fix already on main

Commit `bca8e4f0136ac558c79295bcbdae6d27fd0ad4c7` removes account-triggered navigation and automatic workspace copying. Electron remains the sole writer of explicit connection selection. The renderer closes the sign-in screen when authentication succeeds, including a successful verification followed by an unavailable account refresh. A native Server menu remains available temporarily for recovery from older builds that switched connections. This is an interim recovery measure; the unified design removes connection selection from normal navigation and puts any necessary diagnostic access outside the sidebar.

Verification: 97 focused Node tests and 72 focused Vitest cases passed. An isolated source dev app started, served the changed renderer and delivered hot reload. Native Cloud sign-in remains gated to packaged Electron, so source startup is not an end-to-end native authentication check. The installed 0.3.31 app has not been changed by this source-only fix. No package, release or notarization build was made.

## Current ownership and limits

- `electron/main.mjs` persists connection selection. `electron/cloud-account.mjs` obtains an account's cloud-machine address and pairing grant. Authentication and workspace identity are currently separate concerns.
- Local and hosted servers each write their own JSON, SQLite and files. `server/workspace-backup.ts` can seed a destination, but excludes machine identity and credentials, pauses automation, interrupts pending work and rebases paths.
- `deploy/laterdog/home/src/identity.ts` derives one machine identity from an account. Hosting the canonical workspace while retaining the existing cloud data needs an explicit account-to-workspace/generation mapping.
- `deploy/laterdog/home/runtime/sync.mjs` persists snapshots to object storage. This is not ordered, acknowledged synchronization between two active writers.

## Ownership designs considered

### A. Mac authority with account routing

Callers resolve the account's workspace and send commands through a relay to the existing Mac. The Mac continues to own conversations and schedule work; cloud execution returns results to it.

This can provide an intermediate phone connection in roughly 2–4 engineering days, provided the Mac stays reachable. It cannot provide the full requested cloud-hosted experience while the Mac sleeps. It is not the proposed final architecture.

### B. One cloud authority, seeded from the existing Mac workspace

Callers resolve one account workspace, submit commands for that stable workspace ID and subscribe to its ordered events. Hosting location is an implementation detail. The cloud authority owns canonical workspace state; the desktop keeps a local projection. The workspace supervisor remains the sole scheduler of runs. Mac and cloud executors receive scoped leases and return results to the same threads. That supervisor also selects an available executor with the required capabilities, credentials and granted access, within account resource limits. Storage and executor location do not select a different workspace.

This is the recommended architecture. It preserves the identity of the existing workspace while allowing access when the Mac is asleep. A disconnected desktop can show its cached conversations and explicitly queued commands; it does not become an independent writer. Autonomous offline execution is outside this estimate.

Proposed small contracts, all new:

| Caller operation | Required ownership and data |
| --- | --- |
| Resolve account workspace | Account coordinator returns the one active `workspaceId`, `generation`, `epoch` and endpoint. |
| Submit workspace command | Authority accepts `{workspaceId, requestId, expectedRevision, operation}` and persists a deduplication receipt. |
| Read workspace events | Authority returns ordered events after a durable sequence cursor; the desktop projection has one applying writer. |
| Execute work | Supervisor issues `{runId, epoch, executorId}` with scoped credentials. Stale lease holders cannot commit results. |
| Transfer authority | Coordinator commits a migration ID, generation, epoch and checkpoint digest with compare-and-swap. |

Workspace identity is distinct from account, machine and execution identity. Existing bot, group, thread and message IDs remain unchanged. Binding requires proof of both the signed-in account and the local workspace. A second device resolves the existing binding; it cannot silently replace it with its own local data. Changing accounts cannot reassign an already-bound workspace. Retry, restart and a lost response must recover from durable receipts rather than repeat commands or external effects.

### C. Copy the backup and hide the selector

Rejected: two independently writable stores remain, account routing still selects a machine, and repeat execution or divergent chat histories are possible. File synchronization alone cannot establish command ordering or transfer ownership safely.

## Normal interaction contract

- Signing in attaches the existing workspace to the account without changing the open dog, thread, scroll position or composer draft. A newly signed-in device resolves that same workspace automatically.
- Remove the normal server selector completely. The sidebar shows dogs, conversations and account/workspace identity. There is no local/cloud location mode, switch action or repeated placement question.
- Replace routine Open My Cloud, Copy to My Cloud and local/cloud setup flows with account connection and synchronization state for this workspace. Migration is handled as a resumable account-linking operation; it does not become a second everyday workspace-management screen.
- Reconnect, sleep and executor changes preserve the same conversation. The supervisor handles placement and safe retries. A task needing an unavailable Mac stays visibly waiting for that capability; it does not silently execute without the required files or credentials or ask for a server switch.
- Show a brief synchronization or availability message only when it affects the current action. Detailed storage locations, endpoints, writer epochs and repair controls belong in diagnostics.
- Retained cloud data remains recoverable through advanced account recovery outside the sidebar. Restoring, importing or deleting it is a deliberate action with its own review, never a side effect of sign-in.

## Implementation stages

1. **Identity and retention.** Inventory IDs, relationships, message content, attachments, memory, durable files, active work and external dependencies. Assign the existing local workspace a stable workspace ID and bind it to the authenticated account. Preserve the existing cloud workspace as a separately identified retained generation with a verified recovery snapshot and no automatic expiration or garbage collection. Existing cloud records are not modified by the canonical-workspace import.
2. **Stage the same workspace.** Import a consistent snapshot into a fresh cloud generation with execution disabled. Preserve IDs. Verify content digests and relationships as well as counts. Keep the Mac authoritative during preparation. Destination data must be isolated from the existing cloud workspace.
3. **Transfer ownership once.** Briefly stop new mutations and reach a checkpoint. Drain active turns where possible; explicitly surface work that cannot be safely transferred. Persist a transfer-pending marker that survives restart. The coordinator commits the checkpoint and a new writer epoch. Both sides enforce fencing, including after a crash or restart. A lost commit response is resolved by querying the migration receipt.
4. **Open the same workspace everywhere.** Desktop and phone resolve the account's active workspace automatically. The desktop submits commands and consumes ordered events into its local projection. Cloud and Mac execution report to the existing threads. Remove the server selector and transport-specific account/setup actions from normal desktop and phone navigation at this stage. Automatic executor placement and synchronization operate within the same workspace. Existing cloud data stays accessible through advanced account recovery outside the sidebar. Signing in or reconnecting must never fall back to an empty workspace.
5. **Prove recovery and continuity.** Exercise interrupted uploads, every cutover crash point, lost acknowledgements, reconnects, device revocation, stale writers, duplicate commands, routines and retained-cloud recovery. Compare original IDs and content with both clients after migration. Verify a phone action appears in the existing desktop conversation and vice versa. UI acceptance must cover sign-in, restart, sleep and reconnect without any local/cloud selection step, with the active thread and draft retained. Test that advanced recovery cannot silently replace the account workspace.

Before commitment, an aborted migration can retain local authority after cancellation is durably recorded. After the cloud accepts writes, returning authority to the Mac requires another fenced transfer containing those writes. Reopening the old local snapshot is not a valid rollback.

## Credentials and execution

Workspace content can move without transferring Mac credentials. Provider sessions, MCP OAuth, browser profiles, OS keychains, device pairing and external project directories are excluded from current backups. Mac-only tools and credentials remain behind an authorized Mac executor. Cloud providers need their own supported authorization. A sleeping or disconnected Mac makes its local tools unavailable; the interface must show that limitation while retaining the same conversation. Pending external effects must not be replayed solely because their response was lost.

## Estimate and next decision

- **Safe online migration and one cloud authority:** 8–15 engineering days.
- **Complete desktop projection, reconnect handling and migration hardening:** 15–25 engineering days total, roughly 3–5 engineer-weeks.
- **Not included:** autonomous offline writers, copying native provider sessions, automatic merging of the existing cloud workspace, or deleting any cloud data.

These are planning ranges based on the inspected desktop, storage and home-hosting code. The first implementation checkpoint must validate the accounts-service and phone contracts and measure the workspace inventory before committing to a delivery date. No large implementation or data migration starts as part of this planning request. The proposed scope decision is whether to proceed with design B; deleting the existing cloud data would require a separate explicit decision.
