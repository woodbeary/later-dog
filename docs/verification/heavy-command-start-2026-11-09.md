# run_on_computer waits out a cloud computer's boot

Branch: `kennel/heavy-start-budget-20261109`, stacked on PR 150 (`11f2f15eaa7d9d2b04a49230b8e5ae87be9f13ec`).
First source `2f839db1f27319f2d5572c71d271bd0917429339` (published at `86087f1`, now superseded). Repair source
`d24ea6b` after Root's review of `86087f1`. This record is the only later change.

## Cause

`heavyRunBox` in `server/computers.ts` waited `PROVISION_BUDGET_MS` (90 s) and then failed with
"did not wake within 90 seconds", while the computers service allows a boot 5 minutes
(`BOOT_TIMEOUT_MS`). Root observed repeated snapshot boots of about 4 minutes on
`cmp_n4cksekyrpru`. Whether this 90 s wait caused Patch's failed run is not shown here.

A second limit sits on the same path: the `run_on_computer` tool calls the home with Node's `fetch`,
whose default headers timeout is 300 s. On Node v24.22.2 an isolated server that answered after
305 s failed at 300,931 ms with `UND_ERR_HEADERS_TIMEOUT`. One call could already exceed that before
this change (90 s wake plus the 4-minute run wait).

## Design

Two options were weighed: raise the shared ready/provision defaults, or give only `heavyRunBox` the
existing turn start budget. The second was chosen. `PROVISION_BUDGET_MS` (Settings provision, join,
engine computer) and the 60 s defaults stay as they are.

- `heavyRunBox` uses `cloudComputerStartBudgetMs()` from `server/laterdog/cloud-start.ts` (the
  service boot plus margin, 330 s, same override), capped by the caller's window. If the computer
  is still confirmed `starting` when the window ends, the call answers that nothing was run yet and
  to call again; the next call keeps waiting without waking it again. Error, missing and unknown
  states fail at once, and the service still fails a boot after 5 minutes.
- One call has one window (`WAIT_IN_ONE_CALL_MS`, 4 minutes) measured from the start of the call.
  Startup, sending the folder, setup reuse and the command's wait all draw on it: the route passes
  the time left to `ComputerRuns.run`/`finish`, which read it again after sending, so a 60 s wake and
  a 70 s transfer leave 110 s for the command (previously 180 s). Each status poll asks the computer
  for at most the time left (between 5 s and 30 s).
- If the command finished but the window is used up, its files are not brought back in that call;
  the answer gives the run id, and the next call with it brings them back.
- The route passes `internalCapabilityIsActive` for the call. A revoked, stopped or newer turn stops
  the startup wait (no further wake), and `ComputerRuns.start` checks it again right before it
  launches the detached command, after the upload, unpack and setup awaits. If the turn has ended,
  nothing is launched and no run record or receipt is written; the call answers 409 "nothing was
  run". Files already copied stay in the computer's copy of the folder and their stamps are kept,
  so the next run sends only what changed.
- later.dog no longer puts the computer to sleep after a `run_on_computer` call, and no longer on
  abandonment. The computers service's idle policy (`deploy/laterdog/computers/src/idle.ts`,
  `decideIdle`) already does that: every exec, file write and read counts as in flight and marks
  activity, and an idle computer sleeps after `IDLE_SLEEP_MINUTES` (10; trials 5), at most
  `MAX_AWAKE_HOURS` (8) awake. This removes the second sleep authority, the per-process busy counter
  and the overlap hazard where an abandoned call could stop a computer another call was using.
  Explicit Stop/sleep controls and the service limits are unchanged. Old run records that carry
  `restAfter` still finish by run id; the field is ignored.
- Run records, run_id continuation, the 2-hour limit and transfer bounds are unchanged.

## Evidence

On Kennel's own cloud computer, Node v24.22.2, pnpm 10.33.0. The repair source was committed
(`d24ea6b`) before the long runs; the before case ran in a separate worktree.

- First publication, `2f839db`: 9 files, 87 tests passed; before it (`11f2f15` with those tests)
  12 failed, 33 passed. 95 s and 240 s boots failed with "did not wake within 90 seconds".
- Repair, before (`86087f1` with the repaired `computers.test.ts` and `computer-run-route.test.ts`):
  8 failed, 41 passed. The 60 s wake plus 70 s transfer gave the command 180 s instead of 110 s; a
  turn ended while the folder was uploading still had its command launched (200, not 409); a used-up
  window still brought files back; an abandoned call next to a running one answered 502 instead of
  409. Four failures differ only in the test's shape (`left` instead of `waitMs`, no `rest`).
- Repair, after (`d24ea6b`): 9 files, 91 tests passed (`computers` 33, `computer-run-route` 16,
  `computer-runs` 14, `cloud-start` 7, `boat-wait-ready` 2, `boat-provision` 5, `boat-lifecycle` 3,
  `boat-turn` 1, `no-comments` 10). New cases use the real `ComputerRuns` with a fake computer and
  fake clock: the 110 s budget and poll cap, a write blocked while the turn ends (no launch, no run
  record), a finished run whose files come back on the next call, and an abandoned call overlapping a
  running one. `computers.test.ts` runs three adjacent calls through the real `heavyRunBox` and HTTP
  client: one wake for a 95 s boot, no create, no sleep request, the computer left running, and the
  abandoned third call answered 409 without running anything. The explicit sleep test still passes.
- A first after run had one failure in an unchanged transfer test (a file the command wrote was not
  brought back); that test passed 6 of 6 alone on both `86087f1` and `d24ea6b`, and the full rerun
  passed. Kept as `/tmp/hsb2-after-attempt1.log`.
- The service's own `test/idle.test.ts`: 12 passed (unchanged). `tsc -p tsconfig.server.json`:
  exit 0. No comments in the changed files.

## Limits

- Sending the folder, unpacking, setup reuse and bringing files back are not cut off by the window;
  they are bounded only by their existing per-step timeouts (30 s and 110 s) and size limits (2 GB
  sent, 512 MB back). The window decides whether to wait for the command and whether to start
  bringing files back, so one call is not bounded end to end and can still pass 300 s.
- A computer now stays awake up to the service's idle window (10 minutes) after the last call. The
  real compute cost of that is not measured, and no speedup is claimed from a trace.
- No end-to-end call through the agents MCP server and Claude Code beyond 300 s.
- The native computer MCP `exec` tool (60 s wait) and `engineComputer` (90 s) are unchanged and not
  claimed fixed.
- `bringBack` compares file times with `>` against the start marker, so a file written in the same
  timestamp tick may be missed. Existing behaviour, not changed here.
- No live computer, home or provider use. Not deployed.
