# Native activity and durable work receipts

Desktop and phone display native Claude and Codex work from one server-owned run projection. The active conversation has one compact activity row, up to five selectable native subagents and overflow. Work details show assignments, ancestry, tools, searches and sources, provider-exposed progress and results. Completed turns retain View work receipts, including failed helpers. Existing approval and question cards name the requesting helper.

## Contract and entry points

- `GET /api/threads/:threadId/runs` lists durable runs, newest first, with opaque pagination cursors.
- `GET /api/threads/:threadId/runs/:runId` returns paginated activity.
- Top-level SSE `{kind: "native.run.updated", threadId, run}` carries (`threadId` is repeated at the top level so the member visibility filter applies) a revisioned snapshot; reconnect hydrates the authenticated HTTP projection.
- `POST /api/threads/:threadId/runs/:runId/actors/:actorId/stop` is available only when the observed live actor supports it. A successful response means requested; a later native event confirms completion.
- The activity row, a puppy, overflow and View work all open the same detail surface. Approval and question resolution stays in the existing cards.

The messages database contains run receipts, ordered-event checkpoints and bounded activity previews. Claude and Codex source sequences deduplicate replay without retaining a row or raw payload for every token. Legacy unsequenced sources retain at most 5,000 event IDs per run, then expose a recording-limit notice while allowing the parent to settle. Activity previews are limited to 1,000 items and 2 MiB per run; each conversation retains at most 1,000 completed receipts plus live runs. Missing cursors and removed receipts return `historyIncomplete` so clients display unavailable history explicitly. Conversation deletion removes these records. Backups include them; restore and process restart preserve history without restarting helpers. Retention can remove details while preserving a visibly shortened receipt. Older servers without the endpoints retain the existing progress presentation.

## Isolated checks

Use Node 24 and pnpm. Run focused behavior checks:

```sh
pnpm exec vitest run server/laterdog/native-run-projector.test.ts server/laterdog/native-run-publisher.test.ts server/laterdog/native-run-persistence.test.ts server/laterdog/native-run-retention.test.ts server/laterdog/native-run-frame.test.ts server/routes/native-runs.test.ts server/laterdog/claude-native-activity.test.ts server/laterdog/codex-native-activity.test.ts shared/native-run-selectors.test.ts src/lib/native-runs-state.test.ts src/components/NativeWork.test.ts --maxWorkers=1 --no-file-parallelism
```

The renderer is covered by component tests and the real headless browser against
an isolated fake CLI. Run:

```sh
LATERDOG_UI_E2E=1 LATERDOG_UI_EVIDENCE_DIR=.laterdog-evidence/native-work pnpm exec vitest run scripts/testing/native-activity-ui.e2e.test.ts --maxWorkers=1
node scripts/smoke-native-work.ts
```

The browser fixture checks seven puppies with five visible, overflow, nested
selection, source/results, child-text isolation, focus containment, completion
and retained receipts after reload. It waits for conversation hydration before
reopening a receipt. Screenshots and the final projected run survive cleanup.
The dependency-free smoke opens a real temporary SQLite file, records duplicate
and late events, closes and reopens it, and checks retained results, interrupted
recovery and thread boundaries. It can run in the remote verifier without package
installation or network access.

Also run the driver fixtures, authorization/visibility, inspector-history,
retention and workspace-backup suites. GitHub Actions are absent on current main;
local and remote command receipts are the evidence, not an inferred CI result.

## Live acceptance still required

Fixture success does not qualify a native runtime. First deploy the frozen Cloud image to the existing test Cloud home. Then, after the isolated gates pass and a recoverable account backup exists, use clearly named QA conversations in the authorized real account for both native providers. Retain exact provider versions and sanitized comparisons of native observations with the desktop and phone projection. Existing conversation content remains intact.

Cover nested helpers, native resumption with a new generation, parent/child interleaving, searches and sources, tools, completion, child failures, approval attribution and supported Stop. Unknown events and incomplete observations must stay visible. Test severe or destructive failure cases only in fixtures.

The phone repository has separate decoding, reducer, contract and UI checks. Physical Expo Go acceptance and acceptance of the exact new TestFlight binary are distinct gates. Both apps must resolve the same Cloud home and matching dogs, groups, threads and representative messages. Include older history, attachments, drafts, unread state, background/foreground, relaunch, connection loss and sends in both directions.

Cloud home is the canonical workspace; no companion or Mac-routing restoration is part of this release. Native Projects, native fork operations and after-parent execution lifetimes are separate capabilities, not implied by the activity view. Keep raw account screenshots and traces private. Record final evidence and pending gates in [finish-line.md](../laterdog/finish-line.md).

## Compatibility boundaries

Client scope explicitly allows the history and supported actor-stop endpoints;
thread visibility is still enforced by the route. Claude approval requests carry
native invocation provenance when the provider supplies it. Inspector validation
accepts typed native observations and rejects malformed states. Native Stop is
an optional capability on the canonical ProviderAdapter contract.

`GET /api/helpers` remains a compatibility view of the in-memory helper board.
The durable projection owns the new activity row and receipts, live-helper count
and watchdog checks. Engines lacking native coverage keep the existing progress
presentation. Exact limits and release evidence are in
[the consolidation record](consolidation-release-2026-11-08.md).
