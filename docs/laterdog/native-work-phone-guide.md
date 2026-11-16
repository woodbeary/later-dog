# Native work projection: phone integration guide

The server owns one durable run projection per native turn. Clients read it and never write work state.

## Contract

- Types: `shared/native-runs.ts` (`NativeRun`, `NativeActor`, `NativeActivity`, `NativeRunList`, `NativeRunDetail`).
- Pure selectors: `shared/native-run-selectors.ts` (`applyNativeRun`, `nativePuppies`, `nativeActorRole`, `actorAncestry`, `nativeReceiptAnchors`, `nativeExecutionComparison`, `NATIVE_PUPPY_LIMIT`). No React, no DOM, no store imports.
- Manifest: `shared/native-runs.manifest.json` lists the two source files with SHA-256 and the four wire shapes. Regenerate with `node --experimental-strip-types scripts/testing/native-contract-manifest.ts`; `shared/native-run-selectors.test.ts` fails when the manifest is stale.
- Phone recipe: copy exactly the manifest's `sources` into the phone repository's shared folder in one commit, record the manifest beside them, and have the phone's check recompute the hashes. Do not retype the types or edit the copies.

## Wire

1. `GET /api/threads/:threadId/runs?limit&cursor` returns `NativeRunList`, newest first. `historyIncomplete` means older receipts were removed; show that, not an empty history.
2. `GET /api/threads/:threadId/runs/:runId?limit&cursor` returns `NativeRunDetail` (activities paginated).
3. SSE `{kind:"native.run.updated", threadId, run}` carries a full revisioned snapshot. Feed it to `applyNativeRun`; it ignores replays and stale revisions. On reconnect or snapshot-required, refetch the list and apply each run the same way.
4. `POST …/runs/:runId/actors/:actorId/stop` returns 202 `{status:"requested"}` only when `actor.canStop` is true and the run is live. Completion arrives later as an event. A 404 on the list means an older server: keep the existing helper progress.

An older server has no endpoints; a 404 must not be an error state.

## Rendering rules

- Compact line: `run.currentActivity` plus up to `NATIVE_PUPPY_LIMIT` entries of `nativePuppies(run)` and a `+N` overflow. Every part opens the same detail surface.
- Puppies are native helpers inside one run (`actor.kind === "subagent"`). Tasks and workflows are not puppies. A task given to another dog runs in that dog's own conversation and has its own runs; never merge them.
- Detail: assignment (`task`), ancestry (`actorAncestry`), activities, search links, `summary`, `limitations`, and the shortened-preview notices (`truncated`).
- Receipts: `nativeReceiptAnchors(runs, messages)` places each ended run after its turn's answer; runs without an anchor render as fallbacks.
- Approvals: the card carries `nativeActorLabel` and `nativeRunId` when the server could attribute the request. Resolution stays in the existing card. `answered: "resolved"` means the provider resolved it; show it neutrally, not as allowed or denied.
- Selection: pass the dog's `modelSelection` to `nativeExecutionComparison(run, {instanceId, model})` for a live run. `next-message` means the running execution differs from the current selection and the new choice applies to the next message. `unknown` means a fact is missing; say only what is known. Effort and variant are not reported by the engines, so they are not compared.

## Live step, times and words

Every field below is additive and optional, so an app must fall back when it is missing (an older home, or a run saved before the field existed). All times are milliseconds since the epoch.

| Field | Type | Moves when |
|---|---|---|
| `NativeRun.currentActivity.startedAt` | number | the current step changes; it holds while the same step stays current |
| `NativeRun.lastActivityAt` | number | any step starts or ends, or more text or output arrives, thinking included; never moves back; kept when the run ends; absent before the first step |
| `NativeActor.lastActivityAt` | number | Claude's `task_progress` or `task_updated` for that task, Codex's report of that helper's activity, and any step whose `actorId` is that actor; never moves back |
| `NativeActivity.subject` | string, at most 120 characters | set when the call starts, in plain words only: a command's or helper's own description; the file name as lowercase words (`OrderForm.tsx` → `order form`); the search words; the site's host without `www.`. Absent when the description or search holds a path, a tool name, glob or pattern characters or shell syntax, when the tool is Glob, when the secret filter would change the raw text, and for every other tool. `label` keeps the raw tool name |
| `WireBot.step`, `WireTask.step` | `LiveStep \| null` | the live step of that chat: `{ id, kind, startedAt, lastActivityAt }`, exactly `liveStep(run)` for the chat's live run, `null` when nothing runs there. A new `id` is sent at once; a newer `lastActivityAt` for the same step at most once every 5 seconds per chat |

`shared/step-words.ts` holds the words every app uses, so a step reads the same on every screen. It is pure, uses no Node features and imports only types from `./native-runs`; copy it byte for byte beside the phone's copy of `native-runs.ts`. It exports `activityKindOfTool`, `outcomeKindOfTool`, `stepPhrase`, `ageWords`, `lastMovedWords`, `goingWords`, `foldSentence`, `stepLabel`, `sideJobsWords`, `sideJobsStillGoing`, `helpersLine`, `stepTime` and `liveStep`, and the types `ActivityKind`, `OutcomeKind` and `LiveStep`.

- A live step shows `stepPhrase(step.kind, step.id)`. The phrase is picked once per step id and does not change while the step lasts.
- `liveStep(run)` is the only place the live step is decided. When `step` is missing from a dog or task, compute `liveStep(run)` from the latest `native.run.updated` frame for that chat; the server's `step` is the same value.
- Between steps the id is `${run.id}:thinking:${run.activityCount}`, so the phrase stays put until the next step arrives.
- A finished step reads `stepLabel({ outcome: outcomeKindOfTool(activity.label), state, subject: activity.subject })`; it never shows a tool name, a folder path, command text or a duration.
- Times use plain units only (`for 6 min`, `1 hr ago`), never seconds.

## Limits that must stay visible

Native backends differ in individual stop, background work after the parent ends, and resumption. Show `run.limitations` and `observation` (`partial`, `interrupted`). Work live at a server restart is `interrupted`; no helper is claimed to have survived.

## Checks to port

Replay of ordered events with duplicates, a late child completion after the parent ends, two threads with equal actor ids, a reconnect that replaces a snapshot, and a hidden thread's frame never reaching a restricted member. The desktop versions are in `server/laterdog/native-run-projector.test.ts`, `native-run-persistence.test.ts`, `native-run-frame.test.ts` and `shared/native-run-selectors.test.ts`. Phone rendering and performance are not covered by any of them.
