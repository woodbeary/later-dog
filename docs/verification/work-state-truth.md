# A chat never shows idle while something runs for it

Run the fixtures in isolated homes; nothing here touches a person's app, home or computer:

```sh
pnpm exec vitest run server/laterdog/work-state-table.test.ts server/laterdog/work-state.test.ts server/laterdog/chat-work.test.ts
pnpm exec vitest run server/laterdog/computer-jobs.test.ts server/laterdog/computer-run-route.test.ts server/laterdog/room-work.test.ts server/laterdog/job-wake.test.ts
pnpm exec vitest run src/lib/work-state.test.ts server/laterdog/stop-computer-jobs.test.ts
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
  computer without waking it. A job ends only on evidence: its exit record (with the time it was written),
  or the same one of these on two checks in a row: its computer asleep, its computer missing, or none of
  its processes alive with no exit record. A failed or unsure check starts the count again. Sleep snapshots
  the disk and destroys the computer's container (`deploy/laterdog/computers/src/computer.ts`), but a
  failed destroy still records the computer as sleeping, so one reading is not taken as proof. A job whose
  processes died without an exit record ends quietly with the line "Scout's command on its computer ended
  without a result." and no wake-up. Any other state, an error or an empty answer changes nothing, and a job that runs past two hours is not ended: it stays running, marked
  `computerBackground`. A job a call is waiting on is never checked twice. Each job runs in its own
  process group, whose id is kept on the computer next to its log and exit record, and carries a marker
  its children inherit: `LATERDOG_RUN_ID` in their environment and an open lock file beside its log. When a later
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
or stopped because its computer slept or went away) until the dog is told. `server/laterdog/job-wake.ts`
starts one continuation turn through `startContinuation`, the path the stall watch and restart pickup use,
with a note that is not from the person: the command, how it ended, and the `run_id` to read it with.
Only once the turn has started is the ending marked told and the line written ("Scout's command finished,
so it is carrying on.", tagged `pickup: "computer"`). A home that dies between the two wakes the dog
again after the restart, inside the same bounds; it never shows a "carrying on" line without a turn.

Bounds, each in `server/laterdog/job-wake.ts` unless named:

- Once per job: the ending is removed from the saved ledger when its turn has started
  (`ComputerJobs.announced`).
- At most two wake-ups per message from the person: lines tagged `pickup: "computer"` that start with
  `recovery:` since the person's own last message are counted (`wakesSincePerson`); a teammate's line, a
  handoff, a routine or a webhook post does not start the count again (`fromPerson`). The stall watch keeps
  its own count.
- Only fresh endings: an ending older than 30 minutes is not announced by a turn (`WAKE_FRESH_MS`), so one
  kept through a usage hold or an account switched off does not fire days later.
- Never for a job that ran longer than two hours (`whyNotWoken`).
- Never for a chat whose latest work was a handoff for another dog that is already complete
  (`handoffWorkDone` in `server/laterdog/chat-work.ts`); the result went back with that work.
- Never if the dog read the result itself (`ComputerJobs.ended`, from `run_on_computer`).
- Never after the person's own Stop on that chat (`ComputerJobs.quiet`).
- Only when the chat may carry on by itself, the same check the stall watch uses
  (`mayCarryOnByItself` in `server/index.ts`: the owner's own dog chat, not a guest's, no routine run owning
  it), is not waiting on teammates, and is otherwise idle: no turn or dispatch, nothing queued, no open
  question, not held for usage or waiting on the person for an account, an account that can run. Otherwise
  the ending waits and is tried after every turn ends and at every check.
- Several jobs of one chat make one turn and one line. Group chats are not woken.

Whenever a bound stops a wake-up, the chat gets one plain line ("Scout's command finished. Scout was not
woken for it.") so nothing is silent.

## Stopping a job

Only the person's own Stop on that chat (`POST /api/bots/<id>/interrupt` from the app) stops its jobs; Stop
and send, a dog stopping a teammate, and local tools do not. `server/laterdog/stop-computer-jobs.ts` stops
each job's whole process group on its computer (`ComputerRuns.stop`), then any process still carrying the
job's marker (one that started its own session), and removes the job only once none is left. Where the
computer cannot list processes by the marker, a dead group still removes the job and the chat says "part
of it may still be running". A job on a sleeping computer is left to the watch, which ends it quietly. If it cannot be confirmed, the chat keeps showing the
job and says "Scout's command on its computer could not be stopped, so it is still running.". The desktop
shows Stop whenever something of the chat runs: a turn, helpers, a job, or teammates it awaits, even when a
usage hold or a question outranks them in `work`.

## Words on the desktop

"Running a command on its computer" (or "Running {count} commands on its computer") with a running
timer from `computerSince`, while a chat runs only because of computer jobs. A job past two hours reads
"A command is running in the background on its computer" with the same timer, which counts in minutes
and seconds (for example "134m 05s"). Keys `work.computerJob`, `work.computerJobs`,
`work.computerBackground` and `work.computerBackgroundMany` are English only; other languages fall back
until their packs are drafted with `node scripts/generate-locale.mjs <locale>`.

## Older fields, for the phone

`olderWorkFields` in `server/laterdog/chat-work.ts` now derives these from `work` for every bot and task:

- `waitingForTeammates` is true exactly when `work.kind` is `waiting-on-dog`.
- `waitingOn` is present while teammates it awaits are open and no turn runs, so a usage hold or a
  question that outranks waiting-on-dog does not hide them.
- `activity` is `waiting-on-you` exactly when `work.kind` is `needs-you`, and `working` is shown only
  while `work` is running, retrying or waiting for a computer.
- `helpersWorking` counts helpers plus computer jobs whenever they are alive and no turn runs, whatever
  `work` says.
- For words, the phone reads `work.kind === "running"` with `work.computerJobs` (a count, present only
  when no turn runs) and `work.computerSince` (milliseconds since the epoch), and `work.computerBackground` (how many of them
  have run past two hours, to show quietly), and says "Running a command
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
  command itself for three shapes (a plain command, one followed by more, one inside another shell): the
  process is gone, nobody is woken and the ledger is empty.
- `server/laterdog/stop-computer-jobs.test.ts`: the same three shapes stopped by their process group on
  this machine, and a job kept with a line when its stop cannot be confirmed.
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
