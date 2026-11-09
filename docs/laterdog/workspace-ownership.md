# Attach the existing workspace to the account

## Product decision

The existing Mac workspace is canonical: coordinator, main desk, minor changes, main app, REA, refactor main desk, and their conversations. Account sign-in attaches that workspace to the account. Desktop and phone open the same dogs and chats automatically. Local storage, synchronization and cloud execution are managed behind the scenes. The normal interface has one workspace and no server selector, including no This computer/My Cloud choice in the sidebar. A workspace name or account identity may be shown without becoming a connection picker.

The existing Ember, Willow and Finch cloud workspace is retained separately. This plan does not authorize deleting it, overwriting it, or merging its records into the canonical workspace. Its recovery path belongs in advanced account recovery or developer diagnostics, outside the sidebar and ordinary navigation. It must never become a second default workspace after sign-in or reconnect.

## Current scope: phone access through this Mac

The small implementation keeps the Mac authoritative. It adds account-bound installation registration, the existing authenticated companion tunnel, a short-lived per-phone pairing broker, and phone account resolution. No workspace data is copied or deleted. The sidebar selector is removed; saved connections remain under Settings → General → Advanced.

The desktop's existing `omc_` device session enrolls an installation and pins the first Mac to the account. An account session can resolve only that installation. The phone receives an opaque, expiring pairing grant, redeems it at the companion, and retains its own revocable device credential. An offline or unlinked desktop never falls back to the separate cloud home. Saved phone caches and queued messages are scoped to the resolved workspace.

The installed desktop 0.3.31 lacks this registration and pairing coordinator, so a phone OTA alone cannot activate the connection. The source changes require desktop delivery. Production managed tunnels also require the control-plane `CLOUDFLARE_API_TOKEN`; its deployed secret list currently lacks that binding and `MANAGED_ENDPOINTS` remains off. These are delivery prerequisites, not additional product scope.

Phone access is account-only for every account. Desktop Phone app and onboarding show the download link and same-account sign-in; QR codes, manual phone pairing and phone server selection are removed entirely. Legacy phone pairing links discard their credentials and return to sign-in. The existing companion authorization exchange runs automatically after authenticated account resolution; nobody scans or enters a connection code. Accounts without a registered desktop wait for desktop sign-in instead of opening a separate cloud workspace. Existing local caches and queued sends are archived before destination changes, including retirement of manual connections. Two-account fixtures verify distinct desktop endpoints and grants, including independent revocation. Desktop 0.3.33 delivery and the production tunnel credential remain prerequisites; a source Dev fixture cannot establish real-phone acceptance.

The broader design below is deferred. Cloud migration, synchronization authority, automatic Mac/cloud task routing and operation while the Mac sleeps are not part of this change.

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

This is the selected current scope. The Mac must remain reachable; access while it sleeps is deferred.

### B. One cloud authority, seeded from the existing Mac workspace

Callers resolve one account workspace, submit commands for that stable workspace ID and subscribe to its ordered events. Hosting location is an implementation detail. The cloud authority owns canonical workspace state; the desktop keeps a local projection. The workspace supervisor remains the sole scheduler of runs. Mac and cloud executors receive scoped leases and return results to the same threads. The dog infers the task requirements and chooses the intended execution location. The supervisor validates that choice against current capabilities, credentials, granted access and account resource limits, then records the execution lease. It resolves availability changes against those same task requirements. Storage and executor location do not select a different workspace.

This is the recommended architecture. It preserves the identity of the existing workspace while allowing access when the Mac is asleep. A disconnected desktop can show its cached conversations and explicitly queued commands; it does not become an independent writer. Autonomous offline execution is deferred.

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

## The dog chooses where each task runs

Location is a task decision made by the dog. There is no placement question, per-dog local/cloud setting or Computer-panel toggle in the ordinary flow. The workspace identity and conversation remain fixed while task steps may use different executors. The model states the requirements; the supervisor owns the durable routing decision and execution lease. This separates understanding the request from enforcing availability and authority.

### Signals and decision order

Before starting a computer, the dog derives requirements from the request, referenced resources and current task state. The supervisor verifies resource identity, available tool capabilities, authenticated session location, fresh device presence, resource limits and any checkpoint. A device being reachable by itself is not enough to make it suitable.

| Signal | Automatic routing |
| --- | --- |
| A local path, uncommitted checkout, the running dev app, a Mac app or its existing signed-in session | Use the Mac that owns that resource. Preserve its exact checkout/session identity. |
| Work meant to continue during Mac sleep, a long independent task, or an explicit cloud-browser requirement | Use an eligible cloud executor, provided all required inputs and permissions are available there. Duration never overrides a Mac-only dependency. |
| A phone-initiated task while the Mac is offline | Use cloud for portable work; wait automatically for the required Mac capability when the task depends on local-only state. The phone itself does not imply a different workspace. |
| A mixed task such as reading a local file and doing long-running analysis | Capture an authorized, versioned input on the Mac, run the independent analysis in cloud, and return the result to the same thread. A later local write checks the source version before applying. |
| Ordinary conversation or an API-only operation | Use existing agent/API execution without provisioning a screen computer. |
| Several suitable executors | Reuse the executor with the needed data/session and an active valid task lease; otherwise prefer a ready suitable executor, then wake or provision one. Resource locality and continuity outrank a generic current-computer preference. |

The new task requirements record contains resource references and revisions, required tools/session locality, continuity needs, expected duration, a preferred location with a short reason, and checkpoint/resume constraints. The dog may refine it before an unstarted step when new facts arrive. The supervisor revalidates those facts and persists the selected executor, reason, lease epoch and task identity before dispatch. Location changes never modify the dog's standing defaults or make another workspace active.

### Mac offline, unavailable resources and continuation

If the Mac is offline at dispatch, portable steps run in cloud automatically. Local-only steps enter a durable waiting state and resume when that Mac reconnects with the required capability. Independent work can continue while those steps wait. Do not substitute a similarly named cloud file, a clean Git checkout or a different browser login for the requested Mac resource.

If the Mac goes offline during an action, first resolve the action receipt. Resume from a confirmed checkpoint on an equivalent executor only when the task's dependencies permit it. An unknown send, submit or write outcome is not automatically replayed. External operations use a stable idempotency key when supported; otherwise inspect the result before retrying. A reconnect never starts a second copy of the same run.

A cloud outage permits local fallback only when the Mac can satisfy the same requirements and the task's continuity promise. Otherwise the task waits and retries with bounded backoff. No placement dialog appears. Required account sign-in or missing operating-system permission remains a distinct capability issue; automatic routing does not create access or override an explicit denial. Old transport-selection toggles are removed from normal setup, while access permissions remain separate.

### Quiet feedback after the decision

After the executor confirms startup, show one small non-interactive location label on the existing task/progress row, such as On your Mac or Running in cloud. Collapse the reason behind the existing progress details. A completed receipt can say Ran on your Mac or Ran in cloud. These labels report the recorded executor; they never act as selectors or claim a computer started before it did.

Show one Waiting for your Mac line when a required local capability is offline, then update that same row on automatic resumption. Keep executor IDs, heartbeat history and detailed routing reasons in diagnostics. Do not add repeated chat notices or pre-action confirmation cards for choosing a location.

### Existing mechanisms to reuse, and their gaps

| Existing mechanism | Reuse | Required extension |
| --- | --- | --- |
| `select_computer` in `server/drivers/agents-catalog.ts` and `agents-call.ts` | A dog can inspect targets and request `auto`, `local` or `cloud` without a menu operation. | Keep it as an internal task-placement operation; remove its dependence on a visible selector and expose task requirements. |
| `pickComputer` in `server/computer-selection.ts` | Current order is a usable current target, any ready target, then one that can start, then one that can be created. An already-claimed lazy-start target can remain current. Cloud precedes local in the option list and wins equal-state ties. | Today suitability is only availability/current-target state. Filter and rank by required resource/session identity, continuity and capability before applying reuse/wake/provision preference. Initial mounting currently follows a different order; use this same resolver for initial mount, handoff and retry. |
| `selectableComputers` and `continueComputerSelection` in `server/index.ts` | Existing provider readiness, wake/provision checks and a pending handoff that remounts tools and resumes the original request. | Current selection is scoped to eligible direct requests, lives partly in process memory, and can pin a conversation surface. Move task routing/continuation receipts into the durable supervisor module under `server/laterdog/`, recording the original request, completed actions and continuation cursor; cover phone, room, delegated and routine tasks without replay. Retain immediate invalidation of old computer/browser capabilities after a handoff. |
| `SharedComputers` in `server/shared-computers.ts` and `useMac` in `server/index.ts` | Signed-in Mac registration, file/terminal/screen scopes, presence, offline detection and remote operations. | Integrate the Mac into the same task-capability inventory. Today cloud-home `select_computer` exposes only auto/cloud and Mac access is a separate bridge. Multiple Macs need resource-based selection, and durable waits/receipts replace turn-limited in-memory jobs. |
| Placement classification in `server/drivers/chat-mcp-tools.ts` | Distinguishes inspection from computer operations. | Today auto/local selection can still be approval-eligible. Separate placement from operation authorization so choosing an executor creates no approval card; enforce real file/app/action permissions when executing. |
| `SharedComputerControl` and `TurnResources` | Existing computer ownership and contention handling. | Preserve exclusive screen use while adding durable task/executor leases and automatic resumption after reconnection. |

Today `select_computer` still rejects disabled computer access, missing provider configuration and ineligible request contexts, and some errors direct you to the Computer panel. Existing auto selection is a useful execution mechanism, not yet semantic task routing or unified workspace synchronization. The new flow must resolve ordinary placement/provisioning automatically within account capabilities and show a concrete unavailable capability when it cannot run.

### Routing acceptance cases

- A request to change the existing local repository runs against its actual dirty checkout; opening the running dev app uses its Mac screen.
- Independent long work continues in cloud after the Mac sleeps, with results in the same thread.
- Phone requests use cloud while the Mac is offline; a local-only file task waits and resumes without a menu choice.
- Mixed local/cloud steps preserve resource revisions and do not overwrite concurrent local edits.
- Restart, lost handoff acknowledgement, late executor results and device revocation produce no duplicate run or external effect.
- Missing capability, denied access and temporary offline state remain distinguishable; none opens a local/cloud placement question.

## Implementation stages

1. **Identity and retention.** Inventory IDs, relationships, message content, attachments, memory, durable files, active work and external dependencies. Assign the existing local workspace a stable workspace ID and bind it to the authenticated account. Preserve the existing cloud workspace as a separately identified retained generation with a verified recovery snapshot and no automatic expiration or garbage collection. Existing cloud records are not modified by the canonical-workspace import.
2. **Stage the same workspace.** Import a consistent snapshot into a fresh cloud generation with execution disabled. Preserve IDs. Verify content digests and relationships as well as counts. Keep the Mac authoritative during preparation. Destination data must be isolated from the existing cloud workspace.
3. **Transfer ownership once.** Briefly stop new mutations and reach a checkpoint. Drain active turns where possible; explicitly surface work that cannot be safely transferred. Persist a transfer-pending marker that survives restart. The coordinator commits the checkpoint and a new writer epoch. Both sides enforce fencing, including after a crash or restart. A lost commit response is resolved by querying the migration receipt.
4. **Open the same workspace everywhere.** Desktop and phone resolve the account's active workspace automatically. The desktop submits commands and consumes ordered events into its local projection. Cloud and Mac execution report to the existing threads. Remove the server selector and transport-specific account/setup actions from normal desktop and phone navigation at this stage. Automatic executor placement and synchronization operate within the same workspace. Existing cloud data stays accessible through advanced account recovery outside the sidebar. Signing in or reconnecting must never fall back to an empty workspace.
5. **Prove recovery and continuity.** Exercise interrupted uploads, every cutover crash point, lost acknowledgements, reconnects, device revocation, stale writers, duplicate commands, routines and retained-cloud recovery. Compare original IDs and content with both clients after migration. Verify a phone action appears in the existing desktop conversation and vice versa. UI acceptance must cover sign-in, restart, sleep and reconnect without any local/cloud selection step, with the active thread and draft retained. Test that advanced recovery cannot silently replace the account workspace.

Before commitment, an aborted migration can retain local authority after cancellation is durably recorded. After the cloud accepts writes, returning authority to the Mac requires another fenced transfer containing those writes. Reopening the old local snapshot is not a valid rollback.

## Credentials and execution

Workspace content can move without transferring Mac credentials. Provider sessions, MCP OAuth, browser profiles, OS keychains, device pairing and external project directories are excluded from current backups. Mac-only tools and credentials remain behind an authorized Mac executor. Cloud providers need their own supported authorization. A sleeping or disconnected Mac makes its local tools unavailable; the interface must show that limitation while retaining the same conversation. Pending external effects must not be replayed solely because their response was lost.

## Deferred work

Cloud authority, data migration, automatic task routing, autonomous offline writers and merging retained cloud records are deferred. No cloud data is deleted by the phone-access change.

## Placed Claude task workspaces: computer or home (2026-11-09)

This section is separate from the account-workspace design above: it covers only the task
folder a placed Claude engine works in. Status: recommended 2026-11-09; Option A is implemented behind a per-dog flag for
placed Claude dogs only, default off, not deployed. Evidence:
[workspace-ownership-2026-11-09](../verification/workspace-ownership-2026-11-09.md).

### Where this starts

The later.dog Cloud home is one Cloudflare container with default scheduling, a 20 GB
disk and no snapshot support. Moving it to `durable_object` scheduling would need a new
class and namespace, and that is out of scope. Its working set is about 14 GB:
task-workspaces 4.42 GB, providers 3.63 GB, `.claude` 1.48 GB, older media and downloads
about 2.8 GB. The rollout records in [finish-line.md](finish-line.md) show the home
regularly flagged low on space (minimum free about 1.5 GB).

Each dog's cloud computer (`deploy/laterdog/computers`, the `DogComputer` Durable Object,
`durable_object` scheduling) already takes a native container snapshot every time it
sleeps and restores it on wake. It also has saved per-repository environments.

Remote Claude engine placement is live
(`server/laterdog/engine-{remote,placement,files,relay,proxy,opener,renewal}.ts`). Before
each launch it mirrors the working folder to the computer. At every checkpoint (each
result and each MCP tool call) it copies changed files back to the home. So the home
still holds every workspace in full, and placing engines does not reduce the home's disk
use at all.

### The two options

#### Option A: the dog's computer owns the task workspace

The computer's native snapshot is the durable copy. The home keeps a bounded pointer per
workspace (`<data>/engine-workspaces/<dog>/<key>/`):

| Part | Cap | Notes |
| --- | --- | --- |
| `pointer.json` manifest: path, size, sha256, mtime | 20,000 entries and 2 MiB of entries; past the cap the manifest says `truncated` and still counts total files and bytes | Rebuildable folders (`node_modules`, `dist`, `.cache`, …) are skipped, the same set the mirror skips today |
| Artifacts: copies of the newest small files | 1 MiB per file, 2,000 files, 16 MiB total including the git patch | Checked again on the home as each file arrives (`ArtifactBudget`) |
| Git state: HEAD, branch, `git diff --binary HEAD` | Patch up to 2 MiB; past that, only `patchTooLarge` is recorded | Untracked files are not in the patch; they are in the manifest and, if small, in the artifacts |

New writes stay on the computer. The session transcript, file history and the account
folder keep syncing exactly as today, because the chat and resume need them on the home.

#### Option B: the home owns the workspace (today)

The home's copy is authoritative. The computer receives a mirror before each launch and
copies changes back at every checkpoint.

### Trade-offs

| | Option A: computer owns | Option B: home owns |
| --- | --- | --- |
| Home disk per placed workspace | Bounded: at most about 2 MiB of manifest plus 16 MiB of artifacts | The full workspace, as today |
| Checkpoint cost | Hash and walk on the computer, then send the manifest plus changed small files | Every changed file crosses the relay |
| Home reading a file | Goes through the relay, which wakes the computer (seconds to about a minute); can fail if the computer cannot start | Local and instant |
| Durable copy | One native snapshot per computer, taken on sleep, with a 30-day lifetime | The home's disk; its own backup story applies |
| Computer lost | Work since the home's last copy is lost except the artifacts, which are listed exactly | Only the work since the last checkpoint is lost |
| Engine falls back to the home | Not allowed once the computer owns the work; the turn fails and says why | Allowed, and the next run carries on from the home copy |
| Size ceiling | Seeding a new workspace is still limited to the mirror's 512 MiB transfer cap. After seeding, the size limit is the computer's disk | 512 MiB per launch transfer |

#### Snapshot lifetime and image ties

- A container snapshot lasts 30 days, and the clock resets when it is restored. The Worker
  already models this as `SNAPSHOT_TTL_MS` with a three-day `TTL_MARGIN_MS`
  (`deploy/laterdog/computers/src/environments.ts`). Hold checks treat a snapshot as proof
  only before `snapshotAt + 30 days - 3 days`. They ignore the reset-on-restore extension,
  which is conservative.
- A snapshot belongs to the image it was taken on. **Update** moves a computer to the
  current image and carries only `/home/dog` (`carry.ts` `PACK_SCRIPT`). A placed
  workspace sits at the home's absolute path, outside `/home/dog`, so an Update would drop
  it. With Option A, Update is refused while any workspace is held.
- **Reset** restarts from the last snapshot. Anything written since that snapshot is
  gone. With Option A, Reset is allowed only when the last snapshot is newer than the newest
  held write and still within its lifetime.
- **Delete** removes the record, and with it the only reference to the snapshot. A
  snapshot can never prove capture for a delete, so Delete is refused while any workspace
  is held.
- A computer asleep for more than 27 days with a held workspace is the one way Option A can
  lose work without any operation being refused. The hold view reports
  `snapshotExpiresAt` so the home can see it coming. A periodic refresh wake is **not
  built**; see the release needs in the verification note.

#### What the home and the chat need from a workspace

- **Session transcript, file history, account file:** still synced to the home, unchanged.
  Resume, carry-on and the transcript reader keep working.
- **File reads for the chat and the home's tools** (opening a file the dog mentions,
  links in the transcript, review tools): `readOwnedWorkspaceFile` asks the computer
  through the existing process stream and relay (`read` frame). Asking wakes the computer
  if it is asleep (`engineComputer` → `waitRunning` → wake). If the computer cannot be
  reached, it falls back only to a copy whose hash matches the manifest: first the saved
  artifact, then the home's older copy. Otherwise it fails honestly with 503 and the
  reason. The owner can reach it at
  `GET /api/bots/:id/engine-workspaces/file?cwd=&path=`. The existing readers in
  `server/index.ts` and `server/workspace.ts` still read the home path directly. Rewiring
  them is outside the paths this change may write and is listed as a release need.
- **Listing:** the bounded manifest answers "what is there and how big" without waking
  the computer (`GET /api/bots/:id/engine-workspaces`).

#### Recovery, honestly

| Event | What survives |
| --- | --- |
| Computer asleep, snapshot fresh | Everything, after a wake |
| Computer reset with a fresh snapshot | Everything up to that snapshot. Reset is refused otherwise |
| Computer or snapshot lost (expired, failed restore, deleted outside later.dog) | The next launch finds the computer folder empty. It rebuilds the workspace from the home's last copy plus every artifact whose hash matches the manifest. The chat's stderr and `pointer.recovered` name exactly which manifest files could not be recovered. The git patch is kept on the home, but it is not reapplied automatically |
| Engine running when the computer dies | Writes since the last checkpoint are lost, the same as Option B |
| Owner wants the workspace back on the home | `POST /api/bots/:id/engine-workspaces/home`. Checks free space first: needs `totalBytes + 512 MiB`, otherwise 507. Copies every file through the relay and never deletes a home file. A home file edited after the computer took ownership is kept, and the computer's version goes to `conflicts/`. Only after every file arrived does it ask the computer to release the hold; the computer refuses if newer work exists |

#### Home restart and stale leases

- The hold lives in the computer's Durable Object, so it outlives the home. A restarted
  home finds `pointer.json` on its data disk and the hold still in place.
- A turn that was running when the home stopped behaves exactly as today: the relay
  loses its transport and kills the engine, and the per-thread lock file
  (`<remote>/locks/<thread>.lock`) is taken over by the next relay once its holder pid is
  gone. The credential lease from `engine-renewal.ts` is in memory and ends with the
  process. A new turn asks for a new one.
- A home that lost its data disk loses the pointers but not the holds. The computer then
  refuses Delete and Update, which is the safe direction. Clearing that state needs the
  workspace brought home, which needs a pointer. A data-disk loss on the home therefore
  needs an operator; see release needs.

#### Codex

Out of scope. Placement is Claude-only, and the Codex driver does not import any
placement or workspace module (`engine-workspace.test.ts`, "Codex dogs").

### Recommendation: Option A, behind the existing placement flag

Option A is the only design that lowers the home's disk use. It does so with the provider's
native snapshot and a bounded pointer. It adds no new storage layer, cache, FUSE mount
or retention service. Its failure modes are explicit refusals rather than silent loss.
The one exception is the 27-day sleep window, which is named above and in the release
needs. Option B stays the default and is unchanged.

### How it is built

- **Option:** `remote-engines.json` gains `workspaceOnComputer: [dogIds]`. Set it with
  `PUT /api/bots/:id/engine-placement {"placement":"computer","workspace":"computer"}`.
  The option counts only while the engine is placed on the computer. Free-trial computers
  never hold a workspace. Turning the option or the placement off is refused (409) while
  the computer owns work.
- **Ownership (`ownedWorkspace`, `engine-pointer.ts`):**
  1. Before configuring, the home asks the computer to hold the workspace key (a `hold`
     frame on the process stream). If the computer will not hold it (an older Worker,
     too many holds), the launch is not dispatched and, on a first launch, runs on the
     home.
  2. **Not yet seeded:** the home copy is authoritative and is mirrored as today. Removals
     on the computer are allowed because nothing there is authoritative yet. If this
     fails, the hold is released and the pointer goes back to `home`.
  3. **Seeded, and the computer has files:** nothing is pushed. The computer wins.
  4. **Seeded, and the computer folder is empty:** recovery, as above.
  5. At each checkpoint the relay sends the manifest, changed artifacts, the git patch,
     and removals of evicted artifacts. The home re-caps and stores them, then raises
     the hold to the manifest time.
- **Computer side (`deploy/laterdog/computers`):** `workspace-holds.ts` holds the rules.
  `DogComputer` stores `holds` (at most 64 keys, each the newest write time) and shows
  `workspaces: { held, writtenAt, captured, snapshotExpiresAt }` on the computer view.
  Reset, Update and Delete refuse with `409 workspace_held` as described. A refused delete
  keeps the computer listed. Trial expiry stops on a held computer and retries rather than
  deleting it.
- **Fallback:** `EngineProcess` gets a `homeFallback` switch. It is off once the computer
  owns the workspace, so a placement failure fails the turn with
  "This dog's workspace lives on its cloud computer…".
