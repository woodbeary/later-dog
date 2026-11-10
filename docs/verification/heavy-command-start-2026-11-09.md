# run_on_computer waits out a cloud computer's boot

Branch: `kennel/heavy-start-budget-20261109`, stacked on PR 150 (`11f2f15eaa7d9d2b04a49230b8e5ae87be9f13ec`).
Source tested: `2f839db1f27319f2d5572c71d271bd0917429339`. This record is the only later change.

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
  service boot plus margin, 330 s, same override), capped by the caller's window.
- One call keeps to the existing 4-minute window (`WAIT_IN_ONE_CALL_MS`): startup may use it, and
  the command's wait gets what is left (at least 5 s). If the computer is still confirmed `starting`
  when the window ends, the call answers that nothing was run yet and to call again; the next call
  keeps waiting without waking it again. Error, missing and unknown states fail as before, and the
  service fails a boot after 5 minutes.
- The route passes `internalCapabilityIsActive` for the call. A revoked or ended turn stops the
  wait (no further wake), and a command is never started once the turn has ended; a computer woken
  only for it is put back to sleep.
- Run records, run_id continuation, the 2-hour limit and transfer bounds are unchanged.

## Evidence

On Kennel's own cloud computer, Node v24.22.2, pnpm 10.33.0.

- Before, `11f2f15` with only the new tests: 12 failed, 33 passed (`computers.test.ts`,
  `computer-run-route.test.ts`). A 95 s and a 240 s boot failed with "did not wake within 90
  seconds"; a turn ended during startup still had its command run (200, not 409); there was no
  still-starting answer and no per-call wait budget. Two failures (error and Stop) differ only in
  message text.
- After, `2f839db`: 9 files, 87 tests passed (`computers` 32, `computer-run-route` 13,
  `computer-runs` 14, `cloud-start` 7, `boat-wait-ready`, `boat-provision`, `boat-lifecycle`,
  `boat-turn`, `no-comments`). The boot tests use the real HTTP client against a fake service with
  a Date-only fake clock: one wake and no create for 95 s and 240 s boots, a still-starting answer
  then success across two windows, failure at 330 s when it never starts, fast failure on error,
  and no further wake once unwanted.
- `tsc -p tsconfig.server.json`: exit 0. No comments in the changed files.

## Limits

- No end-to-end call through the agents MCP server and Claude Code beyond 300 s; the client limit
  is shown by the isolated fetch probe, and the design keeps each call within 4 minutes plus
  transfers.
- The native computer MCP `exec` tool (60 s wait) and `engineComputer` (90 s) are unchanged and
  not claimed fixed.
- File transfers count toward a call's time as before.
- No live computer, home or provider use. Not deployed.
