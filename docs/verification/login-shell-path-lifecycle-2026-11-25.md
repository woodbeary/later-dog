# Login-shell PATH probe lifecycle

Observation: a login-shell probe could finish after its cache was reset and append
its obsolete PATH to the new cache. A pending probe could also complete after a
fixture became sealed. The callback had no ownership check, and reset left the
child running.

The fix tracks the active probe. Reset invalidates it before stopping its child;
late callbacks are ignored. A completed probe releases ownership even on error.
A rescan still retains the last successfully resolved login-shell PATH.

## Verification

Base: `4476525fab0e2688459709cf68bf26ecd04ecc95`, on Node 24.22.1,
pnpm 10.33.0 and Vitest 4.1.10, macOS arm64.

The new `server/env-path-lifecycle.test.ts` controls completion callbacks rather
than relying on shell scheduling. On the unchanged base, four cases failed and
one passed. After the fix all five passed:

- A delayed result cannot change a cleared sealed PATH.
- Reset stops the owned pending child.
- An obsolete rescan cannot overwrite a newer result; the previous resolved PATH
  remains available during a rescan.
- Sealing while a probe is pending prevents its result from being applied.
- A completed failed probe is released and is not stopped on a later reset.

The new file, existing `server/env-path.test.ts`, comments and repository-name
checks passed together: four files, 41 tests passed, 11 existing platform skips.
The real-shell rescan and sealed-fixture checks passed without changing their
assertions or timing. No existing assertion, timeout, retry or skip setting changed.

Whole-repository lint passed with zero warnings and errors on 3,516 files. The
public typecheck passed both full graphs: 1,118 app files and 1,738 server files,
including the new regression file. `git diff --check` passed.

Raw negative and positive logs are in the CI lane workspace
`desktop-workers-evidence/` and on the Mac under
`~/laterdog-wt/ci-fast-evidence/desktop-workers-20261125/`.

## Limits

This is a lifecycle repair, with no worker configuration change. The preceding
184-file worker experiment remains rejected: baseline 763.593 seconds passed;
candidate 438.417 seconds failed one existing sealed-PATH assertion. Those times
are not a passing speed comparison, and this repair has not been benchmarked
against that unchanged baseline.

Inference: the deterministic callback case explains a stale-cache failure class
that load can expose. It does not prove the precise scheduling of the original
failure. Separate reused-worker cleanup probes passed their tested module, mock,
global, environment, timer and private-data checks; that is bounded evidence,
not qualification of worker reuse across the entire suite.

A complete clean `pnpm gate` with the required main integration remains pending
before merge. Focused checks do not qualify a merge. Nothing is deployed.
