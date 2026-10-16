# One Cloud home on desktop and iPhone

## Current decision

The account's Cloud home owns its dogs, groups, conversations and work history. Desktop and iPhone are screens onto that same home. The Mac is an executor for its local files, tools and apps. The person confirmed this architecture on 2026-10-16 for the native-activity delivery, preserving the behavior shipped in 0.3.41.

The earlier Mac-authority and companion design in this document is superseded. Do not restore account-to-Mac routing, companion pairing, managed tunnels or a server selector for this delivery. A Cloudflare Tunnel token is not a prerequisite. The corresponding modules were removed on main before 0.3.41.

There is no new workspace migration in the native-activity change. Existing local and Cloud data must remain recoverable. Do not import an older Mac snapshot over the active Cloud home or use an empty workspace as evidence that account acceptance passed. Historical design proposals remain available in Git history.

## Ownership in the current code

- `electron/cloud-account.mjs` resolves the signed-in account's home; the desktop displays its conversations.
- `deploy/laterdog/home/src/identity.ts` derives the account's home identity. The home server owns JSON, SQLite and attachments.
- `deploy/laterdog/home/runtime/sync.mjs` saves the home's state to object storage. It does not merge two independently writable workspaces.
- `server/shared-computers.ts` exposes authorized Mac capabilities to work in the Cloud home. Losing that connection affects Mac-dependent actions, not conversation identity.
- `server/workspace-backup.ts` preserves workspace content while excluding credentials and machine identity. Restored work must not automatically restart external effects.

## Native activity

The server projects provider events into durable runs in the existing messages database. Desktop and phone consume the same authenticated run-list/detail endpoints and revisioned SSE snapshots. Native identities, parentage and execution generations belong to the server; clients must not invent helper completion or start another execution on reconnect.

Only actual native subagents receive puppies. Commands, tools, searches, hooks and other work appear as steps. One compact activity row and one detail surface expose progress, assignment, ancestry, results and supported controls. Completed work remains discoverable through its receipt, including failed helpers when the parent succeeds.

Capability negotiation preserves older clients. Unsupported child forwarding, interruption and incomplete native history remain visible in harness details. Cloud execution retains the current parent-lifetime restrictions until credentials, cancellation and process ownership are addressed separately.

## Acceptance and release

First prove behavior in an isolated fixture and the existing test Cloud home. Source tests and fake-provider events do not qualify live Claude or Codex behavior.

Before upgrading the person's app, retain a recoverable backup. Compare account, home, dog, group, thread and representative message identities across desktop and iPhone. Verify older history, attachments, unread state and drafts. Use clearly named QA conversations for new messages and controlled live-provider tests; leave existing conversation content intact.

Use Expo Go for development on the physical iPhone, then repeat acceptance on the exact new TestFlight binary through iPhone Mirroring. Include background/foreground, relaunch, connection loss, conversation switching and sends in both directions. Record source and build identities, provider versions and any unsupported behavior. Keep raw account traces and screenshots private.

The native-activity implementation, real-account acceptance and release have separate gates in [finish-line.md](finish-line.md). Desktop promotion uses the exact signed, notarized candidate bytes after installation, update, CI and independent-review checks. TestFlight must pass internal Team (Expo) acceptance before distribution to later.dog beta. App Store submission is outside this request.
