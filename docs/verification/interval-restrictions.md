# Interval restrictions

Reviewed against main `7f0c9304` on 2026-09-09. Use the disposable server
fixture described in [routines](routines.md); never test on a live workspace.

## Checks

- 206 focused tests across routines, routine requests, agent tools, package
  import/export, calendar projection, and schedule labels passed.
- Six routine API integration cases, typecheck, targeted lint, renderer build,
  and locale validation passed after integration with main.
- A disposable server with a fake provider completed a real scheduled interval
  run restricted to the current weekday and local time window. Its recorded run
  had `manual: false`, `triggerSource: schedule`, and the expected anchor.
- Editing that routine with a legacy cadence-and-anchor-only payload preserved
  the weekday, window, and end date; explicit `null` values cleared them.
- Tests cover spring-forward/fall-back windows, queued work outside allowed
  hours, expiration, import/export, and rejecting malformed agent proposals.

## In the app

There is no schedule editor: a dog proposes a restricted interval with
`propose_routine` and the person confirms the card. Dog settings → Routines
shows the saved schedule line. The earlier editor screenshots were removed from
the repository on 2026-10-08.

Restrictions follow the scheduler computer's local timezone, matching existing
daily schedules. Time windows must end on the same day; overnight windows are
rejected. No paid provider or live user workspace was used.
