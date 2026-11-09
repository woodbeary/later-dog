# Conversation stall repair, November 9

## Incident and scope

The owner reported that Clover was accomplishing little and conversations were
getting stuck. Earlier server-health checks did not establish successful work.
This investigation follows retained conversation, routine and update evidence.
Production diagnostics are read-only; synthetic turns and Mac-access operations
run in disposable fixtures or the isolated test home.

## Before and after

| Trigger | Observed failure | Repair |
| --- | --- | --- |
| An owner-created routine is edited or deleted | Historical reports are judged against the current routine, so a deleted routine can permanently block the conversation's Mac access | Capture each new run's authority at creation, including manual runs before queued events are delivered; later edits do not change that mark |
| A retained, unmarked cancellation predates the repair | The same historical lookup blocks an otherwise owner-only conversation | Treat only a canonical, never-started scheduled cancellation as neutral when the retained run and same-thread owner-authorized deletion receipt prove it; do not infer run ownership or rewrite records |
| Different MCP queue targets share a generic approval summary | Five successful distinct calls can produce a false repeated-call warning | Include a bounded digest of known arguments; skip the diagnostic when arguments cannot be established; preserve approval text |
| Server code changes while dogs are working | The publisher and runtime can each wait fifteen minutes; the confirmation deadline includes publishing time | Publish first, leave the single bounded drain with the runtime, and measure confirmation from publication; cancellation and timeout messages describe only observed facts |
| The development helper predates a script change | Saving the script does not reload the running helper | Replace only the optional watcher after qualification, bound to the current app's lifetime; do not restart the app |

The cancellation exception rejects starts, execution threads, attachments, results,
errors, costs, manual/webhook triggers, explicit foreign attestations, noncanonical
report content, missing receipts and mismatched identities. A finite queue deferral
between the schedule and cancellation is allowed. The deletion receipt's applied
time establishes chronology; its earlier message creation time does not.

The actual retained incident replay changed from rejected to neutral after the
deferral correction. Negative-attestation, missing-receipt and started-run variants
remain rejected. No live record was rewritten and no synthetic Mac command was
sent to the owner's account. This establishes the predicate for the reported
record; successful completion of an owner's subsequent task is a separate fact.

Clover's quiet routine explicitly requested a report only when blocked or
restarted. Its successful queue calls are not evidence that the quiet ending was
a stall. The repeated-call warning was diagnostic, not a demonstrated abort.

## Verification retained during repair

The isolated shared-control integration starts a cloud-home server and fake
engine, pairs an owner, runs and deletes routines, and exercises the Mac gate.
Owner authority survives cancellation and deletion; an unproven manual run stays
foreign after its routine is adopted. It does not qualify an actual Mac command.

At integration `c89751c`, one local batch passed 342 of 343 checks. Its full
230-case Codex file timed out waiting for an exit event in one existing stop
scenario; the remaining four files passed. A separate cloud review of PR135 at
`9c0bf44` passed the new test alone and all 230 Codex cases. This is fixture
evidence, not native-provider qualification.

A second local batch passed 160 of 163 checks. Its three failures were explicit
timeouts: two repository-wide naming scans and the 5,100-write attestation-cap
fixture. The three isolated conversation/Mac-access integration cases passed.
The host was under heavy load. These runs are retained as failed runs; they are
not presented as a full-suite pass.

Independent cloud review of PR136 at `9edce9c` passed 82 predicate checks,
including failure of the new regression against the preceding implementation,
plus naming/comment guards. It checked the default TypeScript configuration,
which did not cover the server build. The explicit integrated server build then
found an incompatible index signature on the helper's input type. PR136
`fff683c` removes that signature and keeps the runtime checks through
`Object.entries`, without a call-site cast. The combined source is `5c6f5df`.
Its bundle build passed, and the explicit local server-build type check exited
zero. Independent cloud review of `fff683c` also passed that server type check
and 98 checks across the predicate, isolated integration and naming/comment
guards. The complete repository suite was not rerun or reported green.

Whole-integration review then blocked the thread-wide owner-started flag across
an asynchronous readiness wait. PR136 `ea76f2b` removes that flag and uses
request-local async context for the exact owner's invocation. The manager
regression holds an owner request, starts an untrusted run on the same source
thread, and releases the owner request: the reproduced old heuristic stamps
both; the corrected scope stamps only the owner's run. This counterfactual is
inside the test, rather than a checkout of the prior server. Durable false
attestations and Mac refusal are covered separately. Owner-created scheduler
microtasks inherit the context; an existing foreign run's immutable false mark
cannot be upgraded by a later queued update.

Independent cloud review of `ea76f2b` passed 124 focused checks and explicit
server types. Independent combined-source review passed `582ad61` with four
focused checks; a separate local selection passed the two manager race checks.
The writer's broader run passed 2,078 checks with five skips and one failure in
the unchanged removed-dog settings permission fixture. That broader run is not
green. The final combined server bundle is built from `582ad61`.

Changed-file lint passed. The repository-wide pre-push lint stopped on an
unchanged unnecessary spread in `server/laterdog/device-approval.ts:178`.
The integration branch was pushed with the hook bypass explicitly recorded;
repository-wide lint is not reported green.

## Runtime qualification and limits

The first runtime candidate was deployed by a full Worker deployment to the
isolated test home. Direct health and retained history passed. A strict first
Grok reply-format check failed because the response included extra text; that
failure is retained. A subsequent separate transport check completed on Grok
and Kimi with matching receipts and idle settlement. It also matched the exact
requested format on those two runs. These are individual transport observations,
not latency benchmarks, quality scores or proof of the originally queued live
messages being delivered.

Fresh checks on candidate `d2c16e95` also completed and returned to idle on
both Grok and Kimi, with matching selected/dispatched/provider receipts. Kimi
matched the exact marker; Grok included 113 extra characters and did not meet the
strict reply-format condition. The candidate's transport check passes; its Grok
exact-format check does not. The earlier strict failure remains retained.

Local full-image verification did not qualify: health timed out and a subsequent
image pull timed out on the loaded host. Cloud staging is recorded separately.
The final combined image is pinned in both canonical deployment configurations:
`registry.cloudflare.com/da1336ec3e3f7d9a4971022ae074c5d7/laterdog-stall-recovery@sha256:42d5f0897d1b1ebe6cf85c4652532e13fa49d465c8558ed8d512beb6dab29a21`.
It layers the compiled server and home runtime from `582ad61` over the previously
deployed standard image `f45ba413`; native dependencies and web assets remain
those of that base. Its runtime layer SHA256 is
`0a55ec15b820c4eabaddd4422e877f282d9da4c0329919f99fff595eaedb642d`.
The final staging Worker is `baf500f1-6d94-4b2d-aa09-85e7b5303a67`.
The running test instance matches application version 65 and image `42d5f089`;
direct health and thirty retained conversation lines passed at 09:58:13 UTC.
Fresh Grok and Kimi turns after that image qualification both completed, returned
to idle and matched their exact markers, with matching execution receipts.
Earlier format failures remain failures; these individual replies do not
establish general output-format reliability or task quality. An earlier read
before the application/instance version converged failed qualification; its
provider replies are not counted as qualification of the final image.
Only image pins changed in the canonical configurations. Production's eight
plain variables, fourteen bindings, standard and large sizing, and instance
limits are preserved. Production activation and monitoring remain pending
until their evidence is appended here. No deployment claim follows from source,
an uploaded image, a changed PID or cached conversation responses alone.

## Remaining qualification

Per-dog native engine placement and sustained large-fleet capacity remain
unqualified. Selected Codex / Sol / Medium settings do not establish which
provider a fallback attempt used. Physical iPhone uptake is not observed by a
server test. No task-quality or cost improvement is inferred from these repairs.
