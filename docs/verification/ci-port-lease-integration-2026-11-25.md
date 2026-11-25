# Hosted checks and test-port integration, November 25

PR #260 preserves the authored commits from #262 (`7269de60c`) and #263
(`7ed80b413`) and merges current main `4efafe4ce` before qualification. A complete
gate on the combined head qualifies that union; it does not independently
qualify either narrower branch. Exact final commits and complete-gate logs are
recorded in PR #260.

The hosted Checks workflow restores read-only pull-request feedback on Ubuntu:
lint, typecheck, build and packaged-server smoke, Electron and broker tests,
eight suite shards, the three side packages, browser tests and a final verdict.
The full local merge gate remains required.

## Repaired failures

- The approval fixture uses a shared workspace so its approval remains waiting.
  Clean main on the Mac fails this case; the integrated fixture passes all six
  cases. Owner access rules are unchanged by the fixture.
- A command wrapper can be scheduled after the first liveness check. The new
  slow-shell test fails before the startup change. `ComputerRuns.start` now
  waits for its process-group marker, within its existing execution timeout,
  and reports a wrapper that exits before becoming ready. All 26 command-run
  tests pass afterward.
- The corrupt-cache fixture already has the required branch ref before its
  objects are removed. Updating that ref after removing the objects is rejected
  by Git 2.56.1 on Ubuntu. Removing that redundant update preserves the corrupt
  cache and exercises fallback cloning.
- Process-group fixtures signal the recorded group through Node's process API
  after validating the group ID. This avoids differences in external `kill`
  argument parsing.
- Home restores now round a completed file's timestamp to the manifest's
  millisecond precision before deciding whether to download it again. The
  submillisecond-roundoff regression fails before this change; a changed-file
  counterexample still requires another download.
- The home-listing fixture compares the stored file timestamp. Linux returns
  one millisecond less than the requested fractional time on the hosted runner;
  the scan still must match every entry from the independent serial listing.

These files were identical on main and the original #260 head. The initial
hosted failure evidence is Actions run `45552073986`, attempt 1. A failed-job
rerun was started before the fixes. Its result and the final hosted run are in
the PR. The Mac uses Apple Git 2.39.5, so the Git 2.56.1 failure and Linux-only
filesystem behavior are proven by hosted logs rather than a claimed local
reproduction.

## Checked on the Mac

Isolated worktrees under `/Users/jacoblopez/laterdog-wt`; Node 24; heavy work
serialized by `heavy.sh`; temporary test data outside the owner's home.

- Main baseline: 68 of 69 focused tests pass; the approval case fails.
- Slow-wrapper regression: fails on the old startup code and passes after.
- Integrated focused suite: 121 tests pass in command runs, shared clones,
  stopping jobs, question autopick, port leases, the port ratchet, workflow
  contracts, verdict judging and no-comments checks.
- Complete home side package: all 369 tests pass, including 59 sync cases.
- Full gate and hosted qualification: use the exact final head and linked
  logs in PR #260.

Raw logs stay outside the repository in
`/Users/jacoblopez/laterdog-wt/noasks-ci-*.log`. These checks use fake providers
and isolated projects. Real cloud-computer service execution is not qualified
by the local shell fixtures.
