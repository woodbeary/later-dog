# Preserve the workspace during Cloud sign-in

Today Electron alone persists environments.json.activeId and navigates the main window. Cloud account state currently calls connectCloudHome and a once-only backup restore, while the renderer sign-in gate expects navigation to finish it. Local and hosted servers each own their own JSON, SQLite and files. This is copying, not synchronization.

## Designs considered

A. Preserve the existing authority. Callers authenticate with cloudAccount.verifyCode, then update account UI; no workspace command follows. Electron remains the sole writer of explicit environment selection. The renderer owns a completed sign-in gate latch. Cloud account restoration/provisioning never triggers navigation or backup copying. Explicit existing connection controls remain reachable. This is the selected immediate design.

B. Hide the selector while retaining two writable stores. Caller sign-in would still choose a hosted copy, merely without showing its origin. Rejected: it hides separate data and does not establish a single writer or safe retry behavior.

C. Introduce one account workspace authority. Callers send WorkspaceCommand {workspaceId, requestId, expectedRevision} and subscribe to WorkspaceEvent {sequence}; executors submit results with an ExecutionLease {runId, epoch}. The authority owns conversations, the supervisor remains the sole writer of jobs, and devices receive scoped credentials. This is a substantial follow-up, not part of the immediate patch.

## Immediate implementation

- Remove account-state-triggered navigation and automatic workspace backup copying.
- Finish the renderer sign-in gate when authentication succeeds, regardless of cloud machine provisioning.
- Keep saved connections and an explicit route back from a previously opened cloud workspace; do not hide existing data or merge/delete either store.
- Preserve the existing committed source dev launcher and Origin repair.
- Focused Electron tests exercise sign-in/restore with local and custom selections; renderer tests verify completion and no connect/decline calls.
- No version bump, PR, CI wait, release or notarization. Commit integration to main with the CI skip marker; no packaging build is requested.

## Full unification

First route phone access to the existing authoritative Mac workspace and attach cloud execution to its existing threads (rough estimate 2–4 engineering days; Mac must stay reachable). For phone use while the Mac sleeps, introduce durable ordered commands, deduplication, executor fencing, local projections and one verified authority transfer with reconciliation of existing divergent cloud data (rough estimate 3–5 engineer-weeks including migration/failure tests). Independently writable file synchronization is rejected because it can duplicate execution and overwrite conversations.
