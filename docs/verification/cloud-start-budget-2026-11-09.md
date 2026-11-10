# Cloud computer start budget for dog turns

Branch: `kennel/cloud-start-budget-20261109`. Base: `2168474a291b8955b1c426337525f5d9eec2e0b3`.
Source commit tested: `4a718a4dd6941919529676e43e7136b824014406`. This record is the only later change.

## Cause

A dog turn that needs its sleeping cloud computer goes `attachBotBoat` -> `startBotBoat` ->
`wakeBotBoat` -> `readyBoat`. The turn had a 150 s outer budget, but the wake inside it called
`readyBoat` with its own 60 s default, so the turn gave up at about 60 s. The computers service
allows a boot `BOOT_TIMEOUT_MS = 5 * MINUTE` (`deploy/laterdog/computers/src/computer.ts`).
Two Patch turns on 2026-11-09 (23:21:16 and 23:42:57 UTC) ended after repeated
"still starting; call not performed" while the same computer finished a normal snapshot wake
at 23:45:17 UTC.

## Change

- `server/laterdog/cloud-start.ts` holds the facts: `CLOUD_COMPUTER_BOOT_MS` (5 min, matching the
  service) and a 30 s margin for the final read and network. The default turn start budget is
  their sum, 330 s. `LATERDOG_CLOUD_COMPUTER_START_BUDGET_MS` still overrides it, with the same
  1 s floor, so isolated tests keep short budgets.
- Only the turn caller changes: the wake inside `startBotBoat` gets what is left of the turn's
  budget. `wakeBotBoat` and its other caller (the wake route) keep the 60 s default.
  `run_on_computer`, provisioning (90 s) and joins are unchanged.
- The turn's wake stops as soon as no turn still wants it (Stop, or a newer turn generation),
  and never wakes the computer again after that. A newer turn that joins a pending wake keeps it
  alive. A computer that the turn saw starting and that then reports an error is not woken
  again; the turn ends with its existing "didn't start" row.
- The 45 s per-call pending answer is unchanged. No queue, watcher, UI or Worker change.

## Evidence

On Kennel's own cloud computer, Node v24.22.2, pnpm 10.33.0.

- Before, on base `2168474` with only the new tests copied in:
  `vitest run server/laterdog/cloud-start.test.ts server/cloud-computer-slow-start.e2e.test.ts`
  gave 5 failed, 7 passed. A turn stopped during a wake woke the sleeping computer a second time
  (2 resumes, expected 1). A wake that takes 65 s ended the turn at the old 60 s wait
  (`the internal turn capability has expired`). The three new budget unit tests failed.
- After, at `4a718a4`: 11 files, 75 tests passed: `cloud-start`, `cloud-computer-slow-start.e2e`
  (6, including the 65 s wake that attaches with one resume and no create, and the stopped
  turn that never wakes the computer again), `boat-wait-ready`, `boat-turn`, `boat-lifecycle`,
  `boat-provision`, `computers`, `boat-included.e2e`, `place-view.e2e`, `surface-pins.e2e`,
  `scripts/no-comments`.
- `tsc --noEmit -p tsconfig.server.json`: exit 0. No comments in the six changed files.
- A unit test reads the service's `BOOT_TIMEOUT_MS` and `MINUTE` and fails if they drift
  from `CLOUD_COMPUTER_BOOT_MS`.

## Limits

- The fixtures use the included boat relay path; the later.dog computers path shares the same
  caller and has the same guard in `waitRunning`, covered by its unit suite, not end to end.
- A turn that joins a wake started by the wake route inherits that route's 60 s wait.
- A newer turn that joins a pending wake shares the first turn's deadline.
- First-time provisioning still waits 90 s.
- No live computer, home, provider or full server suite was used. Not deployed.
