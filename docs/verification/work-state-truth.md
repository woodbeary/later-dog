# A chat never shows idle while something runs for it

Run the fixtures in isolated homes; nothing here touches a person's app, home or computer:

```sh
pnpm exec vitest run server/laterdog/work-state-table.test.ts server/laterdog/work-state.test.ts server/laterdog/chat-work.test.ts
pnpm exec vitest run server/laterdog/computer-jobs.test.ts server/laterdog/computer-run-route.test.ts server/laterdog/room-work.test.ts server/laterdog/job-wake.test.ts
pnpm exec vitest run src/lib/work-state.test.ts
pnpm exec vitest run server/laterdog/work-state-truth.e2e.test.ts
```

## What each state means

The home sends one `work` per chat (`shared/work-state.ts`), built by `workState` in
`server/laterdog/work-state.ts`. The first true line wins, in `WORK_PRIORITY` order:

| State | True when |
| --- | --- |
| needs-you | an open question, card or sign-in waits on the person |
| waiting-for-usage | the chat is held until an account's usage resets |
| waiting-on-dog | the chat sent work that wants a reply, and that work is still open (named dogs) |
| waiting-for-computer | the turn waits for a computer another chat holds |
| retrying | the turn is reconnecting to its engine |
| running | a turn runs, helpers still work, a job the dog started on its computer is alive, or the chat is doing a handoff for another dog; `helpers` and `computerJobs` say how many after the turn, `computerSince` when the oldest live job started |
| stopped | the last turn ended without finishing and nothing runs now |
| idle | nothing runs and nothing waits |

## The table

`server/laterdog/work-state-table.test.ts` is the specification. It builds every row from the real
records: a `RoomHandoffs` record for handoffs, a `ComputerJobs` ledger for jobs, a `HelperBoard` for
helpers. A restart reloads the job ledger from disk and starts with an empty helper board.

| Turn | Helpers | Job | Awaits reply | Sent, no reply | Doing handoff | Needs you | Usage | Restart | State |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | idle |
| yes | | | | | | | | | running |
| | yes | | | | | | | | running |
| | | yes | | | | | | | running |
| | | yes | | | | | | yes | running |
| | yes | | | | | | | yes | idle |
| | yes | yes | | | | | | yes | running |
| | | | yes | | | | | | waiting-on-dog |
| yes | | | yes | | | | | | running |
| | | yes | yes | | | | | | waiting-on-dog |
| | | | | yes | | | | | idle |
| yes | | | | yes | | | | | running |
| | | yes | | yes | | | | | running |
| | | | | | yes | | | | running |
| | | | yes | | yes | | | | waiting-on-dog |
| yes | | yes | yes | | | yes | yes | | needs-you |
| | | yes | | | | yes | | | needs-you |
| | | | yes | | | | yes | | waiting-for-usage |
| | | yes | | | | | yes | | waiting-for-usage |
| | | | | | | | yes | yes | waiting-for-usage |
| | | | yes | | | | | yes | waiting-on-dog |

The same file checks all 512 combinations: never idle while a turn, a job, a handoff or a
surviving helper is alive; never running with nothing alive; never waiting-on-dog from work sent with
no reply wanted; and the older fields below agree with `work` in every row.

## Where each fact comes from

- Computer jobs: `server/laterdog/computer-jobs.ts`. A `run_on_computer` call
  (`server/laterdog/computer-run-route.ts`) records the job with its chat when the command starts, ends it
  when the call sees it finish, and keeps it when the call returns while it still runs. A watch in
  `server/index.ts` checks kept jobs every 30 seconds (`LATERDOG_COMPUTER_JOB_CHECK_MS`) on the dog's
  computer without waking it: a finished job, a computer that is not running, or a job older than the
  longest a run may take ends the job. A job a call is waiting on is never checked twice. When a later
  turn picks the result up by `run_id`, the call holds the job, so the chat stays running through the
  hand-over and goes idle only when the call has brought the result back.
- Handoffs: `directHandoffFacts` in `server/laterdog/chat-work.ts`, read from the handoff record
  (`server/room-handoffs.ts`). Work wanting a reply that is still open makes the sender wait on that dog;
  work sent with `reply: "none"` never does; a handoff node running in this chat makes it running. A
  handoff waiting in line for a busy dog is not shown as waiting in either chat.
- Group chats: `roomWorkFor` in `server/laterdog/room-work.ts` adds the helpers and computer jobs of
  every chat in the room; the dogs that own the jobs are named as working.
- After a restart: the job ledger (`computer-jobs.json` in the data folder) survives and the watch
  confirms each job on its computer. Engine helpers end with their engine, so they are not counted after
  a restart; their activity is marked interrupted, and a turn that was running is picked up again by the
  restart pickup, which writes its own line.

## Waking the dog when its job ends

When the watch sees a kept job end, the ledger keeps how it ended (finished, failed with its exit code,
or stopped) until the dog is told. `server/laterdog/job-wake.ts` then starts one continuation turn through
`startContinuation`, the path the stall watch and restart pickup use, with a note that is not from the
person: the command, how it ended, and the `run_id` to read it with. The chat shows one line tagged
`pickup: "computer"`, for example "Scout's command finished, so it is carrying on.". Bounds:

- Once per job: the ending is removed from the ledger, which is saved, before the turn starts
  (`ComputerJobs.announced`). It survives a restart until then.
- Never if the dog read the result itself: a `run_on_computer` call that brings the result back removes
  the job (`ComputerJobs.ended`).
- Never after the person's Stop: Stop removes the chat's jobs and stops the ones still running on the
  computer (`stopComputerJobs` in `server/index.ts`, called from `stopThreadTurn`).
- Only when the chat is otherwise idle: no turn or dispatch, nothing queued, no open question, not held
  for usage or waiting on the person for an account, an account that can run (the `free` check where
  `createJobWake` is wired in `server/index.ts`). Otherwise the ending waits; it is tried again after every
  turn ends and at every check. A turn refused for a free slot puts the ending back without a second line.
- Several jobs of one chat that ended before the dog was free make one turn and one line.
- Group chats are not woken; their job endings are dropped with a log line.

The desktop says "Running a command on its computer" (or "Running {count} commands on its computer")
with a running timer from `computerSince` while a chat runs only because of computer jobs
(`src/lib/work-state.ts`, `src/components/WorkStatusLine.tsx`); the sidebar row shows the same words.
Keys `work.computerJob` and `work.computerJobs` are in English only; other languages fall back until
their packs are drafted with `node scripts/generate-locale.mjs <locale>`.

## Older fields, for the phone

`olderWorkFields` in `server/laterdog/chat-work.ts` now derives these from `work` for every bot and task:

- `waitingForTeammates` is true exactly when `work.kind` is `waiting-on-dog`.
- `waitingOn` is present exactly then, with the same dogs.
- `activity` is `waiting-on-you` exactly when `work.kind` is `needs-you`, and `working` is shown only
  while `work` is running, retrying or waiting for a computer.
- `helpersWorking` counts helpers plus computer jobs while `work` is running after the turn, and is absent
  otherwise.
- For words, the phone reads `work.kind === "running"` with `work.computerJobs` (a count, present only
  when no turn runs) and `work.computerSince` (milliseconds since the epoch), and says "Running a command
  on its computer" or "Running {count} commands on its computer" with a timer from `computerSince`. Lines
  with `tool.pickup === "computer"` are pickup lines like `"restart"` and `"watch"`.

With these agreeing, the phone can read `work` alone and drop its rebuild from the older fields.

## What was proven

- Every table row and invariant above, as unit tests against the real records.
- `server/laterdog/computer-run-route.test.ts`: a run that outlives its call stays counted for its chat,
  survives a check while it runs, and ends when a later call picks it up by `run_id` or when a check sees
  it finished.
- `server/laterdog/work-state-truth.e2e.test.ts`, a real server with the fake engine and a local stand-in
  for the computers service: the engine calls `run_on_computer`, the call returns while the job runs, the
  turn ends and the chat shows `running` with one computer job; it goes `idle` only after the job's own
  output file exists, the dog is woken once with the note, reads the result by its `run_id` (the file comes
  back to the home) and the chat settles idle with exactly one wake line. A home restart with a job alive:
  after the restart the chat shows `running` from the ledger, and the dog is woken once when it ends. A
  job that ends while the home is down wakes the dog once after the restart. The person's Stop ends the
  job: its output file never appears, nobody is woken and the ledger is empty.
- `server/laterdog/job-wake.test.ts`: once per job, one turn for several jobs, waiting while the chat is
  busy, an ending kept when the turn is refused for a free slot with one line, nothing after the dog read
  the result or after Stop, no wake for group chats.

## Not proven on a real home

- The watch against the real computers service (it uses the same exec and state calls a `run_on_computer`
  call already uses), and that a real engine reads the result when woken.
- The usage-hold and signed-out waits are proven only in `server/laterdog/job-wake.test.ts` through the
  `free` check, not with a real held account.
- That a real engine's helpers end with the home on a container restart; this rests on the engines being
  disposed at shutdown and stray processes being reaped, read from the code.
- The phone still rebuilds its state from the older fields; it was not changed here.
