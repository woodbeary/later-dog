# In-chat team coordination

Independent bot conversations now dispatch as soon as a handoff is accepted;
speakers in the same group chat still serialize. A dog waiting for returned
results exposes `waitingForTeammates: true`, not a fake active `busy` turn.
The chat header shows **Teammates working**, leaves the composer usable and
retains Stop. Explicit command-line `wait` still waits for the whole result.
Accepted handoffs survive a failed source provider turn; explicit Stop,
deleted conversations and revoked routes keep their existing cancellation
behavior. This does not add restart replay or remove task capacity limits.

Regression checks (all use disposable fixtures):

```sh
pnpm exec vitest run server/room-handoffs.test.ts server/direct-coordination.e2e.test.ts server/room-coordination.e2e.test.ts
LATERDOG_UI_E2E=1 pnpm exec vitest run scripts/testing/direct-coordination-ui.e2e.test.ts
```

Gated fake-model turns prove a teammate starts before the lead settles,
the lead becomes available while results are pending, failure of the source
does not discard accepted work, and exactly one final answer returns to the
original thread. These tests verify orchestration, not live-model planning.

In an ordinary bot chat or group conversation, ask the lead to consult named
teammates or have them build and review a concrete artifact. No new dashboard,
incoming-route panel or mandatory discussion.

`coordinate_bots` is the one way dogs work with each other, in direct chats,
routine runs and group chats alike; `list_bots` gives the ids of reachable dogs
and the group chats the sender is in. It addresses 1–4 existing dogs in this
group chat (default), or, in a direct chat or routine run, each recipient's one
conversation. A direct request also writes the brief and the reply into the
pair's read-only exchange (a dm group), and the sender's conversation links to
it with "Sent to …" and "… replied" lines. A routine run that asks another dog
waits ("Waiting on another dog") and resumes the same run with the result.
A multi-recipient room request posts its brief once, addressed to all accepted
recipients. Each recipient still has a separate execution and result. An
identical retry does not post again; different briefs remain separate. Requests
in direct conversations keep their individual messages.

Recipients run sequentially per room, with their own models, permissions and
working environments. Busy recipients queue. Once all requested results arrive,
the sender resumes in the original conversation. A lead can consult its own
specialists; it never inherits the parent's access or permissions.
Advice is not a verification
receipt: the lead must ask the reviewer to run the requested checks.

Outside a room, every request goes into the recipient's one conversation:
the first request, a follow-up, a change of plan and rework all land there, so
the recipient has the earlier work in its own history. If the recipient is
already working in that conversation, the request waits and runs next; the same
work never runs twice in parallel. The recipient works at its own model and
permission level; the sender's level is never applied to it. Each receipt names the
recipient's conversation. Within the
sending turn and the turns that resume it, the same text to the same
recipient and place is one request: a repeat while it is live is not sent
again, and a repeat after it finished or failed runs again only with
`rework=true`. Room requests continue to use their explicit destination
thread.

The chat shows an avatar and “Sent to Eli · Delivery”; clicking opens the
receiving conversation. Same-room receipts have no unnecessary navigation.
Receipts remain visible when tool calls are hidden. Files are not copied between
computers: briefs must include accessible absolute paths or the required content.
Returned reports stay available to subsequent model turns behind the compact
receipt, subject to the bounded retention and fresh peer/section access checks.
Direct-chat receipts use the existing avatar/thread pill, opening the exact
recipient task without changing other tasks.

Steering is not cancelling. A message sent while teammates are still working
runs straight away — it is not queued behind them — and the assignments stay
out: they keep running and each result still returns to this conversation and
resumes it. That turn gets no list of what is outstanding; the
`dispatch-supersede` eval pins that the assignment is not sent again and that
the turn still has `coordinate_bots` to send a change to the same teammate.

Direct-chat parking is a per-bot opt-in (`parkDirectMessages`). When it is on,
a message that arrives while teammates are still working waits on the server
and runs as its own follow-up turn once
every outstanding assignment has settled and the resumed coordination has
finished. Steering stays the default; Stop keeps its conversation-scoped
behavior either way.

Stop is scoped to the conversation it was pressed in. It ends that bot's turn
and stops the conversation awaiting its teammates, so nothing resumes into a
stopped chat. An assignment that had not started yet is cancelled, since
nothing is lost. A teammate already mid-turn keeps its own provider process:
it finishes, and its result is still recorded and reported back here as the
usual receipt. Each teammate Stop leaves running gets its own pill in the
transcript — "Stopped here — Eli is still working; open to stop it too" —
which survives Tool calls being hidden and opens that teammate's conversation,
where Stop reaches its turn for real. Deleting a waiting source still cancels
its whole tree, and never recreates the conversation.

Provider work and waiting-on-teammate status stay separate internally, so
waiting does not hold a provider session or block another independent
conversation.

## Repeatable checks

### Broader coordination checks

```sh
pnpm exec vitest run server/peer-roster.test.ts server/room-handoffs.test.ts server/room-coordination.e2e.test.ts src/components/GroupView.test.ts src/lib/room-activity.test.ts --maxWorkers=2
pnpm exec vitest run server/drivers/agents-proxy.test.ts --maxWorkers=2
pnpm exec vitest run server/room-recovery.e2e.test.ts server/testing/room-handoff-agent.test.ts
pnpm exec vitest run server/direct-coordination.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/turn-dispatch-guard.test.ts
pnpm exec vitest run server/thread-aware-bots.e2e.test.ts server/routine-delegation.e2e.test.ts server/routine-results.e2e.test.ts server/independent-threads-api.test.ts server/peer-allowlist.e2e.test.ts server/steer-queue.test.ts
LATERDOG_UI_E2E=1 pnpm exec vitest run scripts/testing/direct-coordination-ui.e2e.test.ts
```

The integration suite launches the disposable control fixture and drives the
actual injected agents MCP proxy with a scripted provider. It checks same-room
multi-recipient consultation, cross-room work and return, busy peers, cancellation,
provider failure, thread pinning, section changes, peer revocation and
validation. The owner's own dogs send without a peer-approval card. It does not claim model judgment or artifact correctness.
The direct-chat suite exercises Clive → lead → specialist → lead → Clive with
the real MCP proxy, no room, and no changes to unrelated conversations. It also
checks that follow-ups from one conversation continue one recipient thread
(queued behind running work, never in parallel), that another conversation
gets its own thread, thread titles, work that closes itself and reopens, recipient model/permission
defaults, idempotency without extra tasks, capacity-bound queues, dispatch to a
spare recipient thread while unrelated work remains active, pinned parent
selection, steering a live coordination (including an automation turn
landing in the same conversation), conversation-scoped Stop, source
deletion, access revocation, and fresh transcript replay after
revocation. The UI test sends from the real
composer and opens the handoff receipt into the pair's read-only exchange,
with ordinary tool chips hidden. Screenshots and JSON are retained beside the
fixture's printed server log; all fixture processes and temporary data are closed.
Follow-up checks cover retained report context and withholding after peer access
is revoked, without mirroring a second visible transcript.
Addressing checks cover what a bot may put in a `bot_ids` slot: an id is always
an id; a name that means exactly one reachable teammate resolves to it and the
work runs as if the id had been sent; a name nobody has is refused with the
argument echoed and `list_bots` named (`No bot with id or name "…"`); a hidden
teammate is reached by id or name like any other; a name two reachable teammates
share is refused with the count and the way to the ids, never guessed. Every
`list_bots` line carries the teammate's `[id: …]`.
Unit checks cover bounded depth/fan-out, idempotent retry, original request
retention, automatic return, cancellation and restart without replay, and the
scoped stop: unstarted work cancelled, a running teammate left with its
process, its result still reported, and no resume of the stopped conversation.
Turn-correlation checks cover completion before the provider's dispatch ACK,
late completion after Stop and a replacement turn, cross-thread isolation, and
bounded single-use early receipts. Coordination uses the exact provider turn's
reply, never the latest reply or generation of a reused conversation.
The real fake-Claude subprocess checks transient retry and rejected-cursor
recovery through a nested coordinated task. Driver regressions also prove that
retrying a later turn in a retained session preserves that turn's prompt and
acknowledged identity, not the session's first request.
The recovery fixture restarts the same disposable server with an interrupted
routine and verifies its source-room card and error-free recovery broadcasts.
The subprocess fixture checks malformed output, unexpected exit and bounded
cleanup so an agent-process failure cannot silently pass or hang these tests.
Legacy comms checks enter through real routine execution, where ask/delegate
remain supported. Ordinary-chat checks assert that calling a replaced tool is
an explicit protocol error, never an empty successful reply. Thread checks also
cover self-owned jobs, queued provenance and the transition from a completed
routine back to a normal user conversation.

## Real-model and UI checks

Use an isolated home and data directory, never the running app. Create Maya,
Eli (developer) and Nora (reviewer), set an explicit shared working folder, and
create Launch and Delivery rooms through `control-laterdog`. Send through
`send-channel`, wait on the source channel, and retain `messages` plus the
actual files and executed tool evidence. Follow [channels](channels.md) and
[chat UI](chat-ui.md) for the common launch/control paths.

Ask Maya to have Eli implement a Python CSV export and Nora independently run
tests before reporting. Check both transcripts, inspect actual tool executions,
and independently run held-out CSV cases: empty input, boundary dates,
paid/zero exclusions, quoting and sorted output. Also try a pure consultation
where each bot holds different requirements. Do not supply special tool
instructions in the user prompt.

Open the disposable preview, inspect both avatar receipts with tool calls hidden,
click a receipt and verify the actual receiving conversation. Stop all owned
preview/server processes afterward; retain evidence without credentials.

## Limits and safety

Existing peer allow-lists/approvals and every room reader's section still apply.
Ordinary chats use one bounded coordination tool for teammate work instead of
the competing ask/delegate/peer-thread execution paths. A dog has one
conversation and no tool to open separate work on itself.
Direct routines, webhooks and legacy peer delivery
retain their existing lifecycle: their completion is not claimed early by this
new loop, and a turn of theirs that lands in a conversation cancels no
coordination there. Cancelling a request
stops the descendants it is still waiting on, except a teammate whose turn had
already started when the person stopped the conversation above it: that process
is left alone and reports its result. Restart records interruption without
replaying side effects.
Limits: four cross-room edges, 24 child requests, 48 executions, 30 minutes per
root. Failures return to the sender, not a false success. Model quality and
provider availability still matter; this is not a guarantee of autonomous
correctness or permission to bypass approvals.

## Live-model evidence — 2026-09-13

The final main-based integration, including exact-turn correlation and Claude
retry compatibility, repeated the nested trial with real Sol. Clive → Patch →
Nora → Patch → Clive completed in approximately three minutes; all three durable
nodes were completed and reported. Nora actually executed the tests. The exact
CSV output, a rerun of the generated test, and two independent held-out cases
all passed. The actual renderer also passed receipt navigation and Chief grant
checks. Evidence (fixture and temporary auth copy removed):
`/tmp/laterdog-live-team-0913.MwRY2k/nested-gpt-5.6-sol-1789255210986/result.json`
and `independent-checks.json` beside it.

Two isolated `gpt-5.6-sol` trials used temporary work folders and real tools:

- Delivery: Clive consulted Mira, assigned Patch, requested Nora's independent
  checks and then Quill's launch copy. The actual CSV exporter and tests passed;
  no deployment or publishing was requested. Evidence:
  `/tmp/laterdog-live-team-0913.MwRY2k/delivery-gpt-5.6-sol-1789253057867/result.json`
  and `transcripts.json` beside it.
- Nested: Clive could reach only Patch; Patch could reach only Nora. The durable
  tree was Clive → Patch → Nora, all completed and reported. Nora executed the
  unittest suite, exact export command and schema/email checks. Patch then
  resumed, followed by Clive, in about 146 seconds. Evidence:
  `/tmp/laterdog-live-team-0913.MwRY2k/nested-gpt-5.6-sol-1789253398198/result.json`.

The first run also exposed a model-quality limitation: Patch claimed Nora had
verified its work without a corresponding later.dog handoff. Clive correctly treated
that claim as insufficient and requested an actual independent check. Prompts
now explicitly require real coordination receipts for named-bot participation;
this is guidance, not a guarantee that every model report is truthful. The
explicit nested run proves actual recipient execution, not merely a plausible
final summary. These live results do not establish every provider's quality.

## How long coordinated work may take, and how it ends

A tree of handed-off work (the dog that asked, its teammates, and whoever they pass work to) is not on a short clock. It stays alive for as long as anything in it shows real progress: a teammate's turn that keeps producing events, a teammate waiting on a card for you or on a computer or helpers, or a request waiting its turn behind a teammate who is busy. The tree ends for time in two cases, both measured by `server/laterdog/handoff-budget.ts`:

- **Nothing moved for 20 minutes** (`rooms.handoffIdleMinutes`): no node showed progress and nothing was waiting on you.
- **4 hours in total** since the tree began (`rooms.handoffHardCapMinutes`), so a runaway loop cannot go on forever. A parent that only owes its final summary gets a short runway past the cap.

New teammate work is refused with a plain message once less than 10 minutes of the cap remains. The legacy `rooms.handoffLifetimeMinutes` is still read as the idle window when `handoffIdleMinutes` is not set.

Each ended request records why in `endedBy` in `room-handoffs.json`, and the words every reader sees follow it:

| `endedBy` | Teammate chip | Text the asking dog reads |
| --- | --- | --- |
| `person` | "Scout stopped" | The person stopped this work. |
| `idle`, `capped` | "Scout ran out of time" | Nothing moved for 20 minutes… / Ran out of time after 4 hours. |
| `interrupted` | "Scout was interrupted" | Interrupted before it finished. |
| `origin` | "Scout never got started" | The request that started this ended before it could begin. |
| `timeout`, `ceiling` | "Scout ran out of time" | Its turn timed out twice… / Stopped after 12 hours… |
| `restart`, `deleted`, `limit`, `problem` | "Scout couldn't finish" | each in plain words |

Only the Stop buttons (a conversation, a room, or a guarded request) say it was stopped by the person. A change that interrupts a dog's turn (switching its engine, tightening its permissions) now says "interrupted".

When a tree ends for time, the asking dog's conversation gets one line, "Ran out of time after 4 hours. Continue?", with a **Continue** button. Continue (`POST /api/handoffs/:id/continue`) starts a fresh tree from the same request: answers that already came back are kept, and each request that did not finish goes out again to the same teammate in the same thread, told to check what is already done and carry on. When they all return, the asking dog resumes and answers you. A tree can be continued once; the button turns into "Picking the work back up where it stopped."

A handoff turn that times out (a room turn past its deadline, or a turn the stall watchdog stops) is tried once more, told to check what is already done and carry on. A second timeout ends it as `timeout`. The stall watchdog counts a tool call that is still running as alive, up to 4 hours for one call.

### The owner's own dogs working without asking

When every dog in a tree is the owner's own dog working without asking (Auto-review off, or Full access), in a conversation no guest drives and on a workspace that is not shared (`server/laterdog/long-work.ts`):

- a room turn and a room handoff turn get 4 hours instead of the 5-minute room default, unless the conversation set its own limit;
- the 4-hour cap does not apply; the tree runs until 12 hours after its first attempt began, then ends with one plain line and no Continue button;
- when nothing moved for 20 minutes, later.dog continues the tree by itself instead of asking "Continue?";
- after a restart, the requests that were running go out again with a note that later.dog restarted.

Everyone else keeps the 4-hour cap, the Continue button, and no replay after a restart; the asking dog's conversation gets one line naming each request to send again.

Checks: `server/room-handoffs.test.ts` (idle, hard cap, honest endings, Continue, long work, retries, restart), `server/laterdog/handoff-budget.test.ts`, `server/laterdog/long-work.test.ts`, `server/turn-watchdog.test.ts`, `src/components/StatusActivityRow.test.ts`.
