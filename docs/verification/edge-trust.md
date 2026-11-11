# Which devices the edge trusts for a sleeping home

Branch `atelier/edge-trust-followup` (pull request #175), on main `89b1439`.
It closes what the review of pull request #167 left open (its findings S5, S6,
S7 and S8) and answers N1 of the third review of pull request #164. Edge only:
`deploy/laterdog/home/src/host.ts` and its two test files.

Everything here was run on the Linux cloud computer against the fake home in
the edge tests. Nothing was tried against a real home or the deployed edge, and
nothing is deployed: the change needs an edge Worker deploy.

## The rule

The edge answers for a sleeping home. It trusts a device (keeps its answers,
holds its messages, lets it wake the home) only while the home has confirmed
that device's session, and it drops a session the home refuses only after
asking the home whether the session still stands (`/api/auth/session`).

## What each finding ended as

| Finding | Ended as | What a stranger or a signed-out session could do before, and cannot now |
| --- | --- | --- |
| S5, nothing pinned the line that clears a refusal noted during a check | test only | Nothing changes. The test holds the rule: a standing session refused one thing again and again during one check costs exactly one more check, and stays trusted |
| S8, the no-clear-answer rule had no test | tests only | Nothing changes. The tests hold the rule: a session the home refuses one thing is dropped when the home answers the check with an error or hangs up on it, and is trusted again after one read the home confirms |
| S6, a standing session was dropped unasked while four checks were out | fixed | A stranger who kept four checks busy with made-up sessions got any real device dropped, with its kept answers, the moment the home refused that device one thing. Now the home is always asked about a session it has confirmed; the limit of four applies only to sessions it has not confirmed |
| S7, a home that changed size re-listed a dropped session | fixed, no stored data changed | A signed-out session the edge had stopped trusting was put back on the list by the home's other size each time the home slept, so under the `owners` guard it woke the home and could open the event stream again. Now the other size drops it too |
| N1, requests the edge answers by itself while the home is up | real, small; narrowed, not closed | A signed-out session that asked only for the held-messages list, Send now or cancel was never asked about again, so it stayed trusted for up to seven days. Now those requests get the same day-old check as every other request |

### S6 in detail

`learn` in `deploy/laterdog/home/src/host.ts` now stops early only for a
session that is not on the confirmed list (when four checks are out, or the
home already refused that session). A confirmed session is always checked. The
confirmed list holds at most 64 sessions and each has at most one check out, so
strangers cannot flood these checks; made-up sessions still share four.

The other way to fix it, leaving the session trusted until a check slot is
free, was not taken: a signed-out session could then keep itself trusted by
keeping the four slots busy. The test "stops trusting a signed-out session the
home refuses, though strangers keep every other check busy" holds that.

Still true, as before #167 and after: while four checks of unconfirmed sessions
are out, a device the home has not confirmed yet (a new device) is not asked
about on that request; its next request tries again. A stranger can delay a new
device's first kept answer this way, not take anything from a confirmed one.

### S7 in detail

When the edge stops trusting a session it now also tells the home's other size
to drop it (`forgetWaker`, next to `knowsWaker`), only on a home that has
changed size. It removes one entry from the other size's stored list of
confirmed sessions; the shape of that list does not change and nothing is
migrated.

If that call fails the other size keeps the entry and the session is listed
again at the next sleep; the next refused request while the home is awake drops
it and tells the other size again. A session the other size knows and this size
has never seen refused still wakes a sleeping home once, because the edge
cannot ask a sleeping home.

### N1 in detail

Is it a real gap, given the day-old check #167 added? Yes, because that check
did not cover these requests. The edge answers the held-messages list, Send now
and cancel before the request reaches the home and before `learn` runs, so
neither a refusal nor the day-old check could ever start from them. A
signed-out session that asked for nothing else while the home was up stayed
trusted until its device note was seven days old.

It is small. Such a session can cancel a held message only if it knows the
message's send id (ids are random, made on the device), the home is up, and the
message is still at the edge, which lasts at most an hour and only while the
home fails to take it or the edge is still answering it. It can learn ids from
the saved chat list the edge serves it while the home sleeps, and in that state
it can already cancel: the edge cannot ask a sleeping home.

What changed: when the edge answers one of these requests for an awake home it
now runs `learn` on it, so a session last checked a day ago is checked again
and dropped if the home refuses it. One line.

What is still open: the request that starts the check is still answered, and a
session signed out less than a day after its last check is not asked about. To
close that the edge would have to ask the home before answering each of these
requests (a round trip on every list request while the home is up, and a rule
for a home that gives no clear answer, which is when messages are stuck), or
the home would have to tell the edge about sign-outs. Neither is small, so
neither is done here.

## New tests, and the line each one holds

Each was run once with the line taken out of `host.ts`.

| Test | Line taken out | Result |
| --- | --- | --- |
| `deploy/laterdog/home/test/desk.test.ts` "asks the home once more, and only once, about a standing session it refuses one thing again and again while a check of it is out" | `this.refusedMidCheck.delete(key)` | 1 failed of 41, `expected 2 to be 1` |
| same file, "stops trusting a session the home refuses one thing when the home answers the check with an error / hangs up on the check, until the home confirms it again" (two cases) | `\|\| (outcome === "unknown" && denied)` | 2 failed of 41, `expected [ Array(1) ] to deeply equal []` |
| same two cases | the `.catch` that turns a failed check into no clear answer | 1 failed of 41 (the hang-up case), same message |
| same file, "asks the home about a standing session it refuses one thing, and keeps trusting it, while strangers keep every other check busy" and "stops trusting a signed-out session the home refuses, though strangers keep every other check busy" | the limit applied to confirmed sessions again, trust kept when no check can run | 2 failed of 44, `expected +0 to be 1`; with main's `host.ts` the same 2 fail |
| same file, "asks the home about no more than four sessions it has not confirmed at a time" | the limit of four removed | 1 failed of 44, `expected 1 to be +0` |
| `deploy/laterdog/home/test/wake-guard.test.ts` "does not boot a home that changed size for a session it stopped trusting, though its other size once learned it" | the call that tells the other size | 1 failed of 37, `expected 'waking' to be 'asleep'`; with main's `host.ts` the same |
| `deploy/laterdog/home/test/desk.test.ts` "asks the home again about a session it last checked a day ago when all that session asks is which messages the edge holds, and stops trusting one signed out since" | the `learn` call on a request the edge answered | 1 failed of 45, `expected +0 to be 1`; with main's `host.ts` the same |

The counts above are from the commit each test arrived in. All seven removals
were run again on the source of `e442824`, one run each of the two test files
together (82 tests): the same tests fail, 1, 2, 1, 2, 1, 1 and 1 of 82.

The first version of the S5 test, with the line taken out, ran the test worker
out of memory instead of failing (the fake home answers at once, so the checks
never stopped). The test now has the fake home refuse a second question, so the
run ends and the count fails.

## What was run at the head

One run each, on the Linux cloud computer, in a copy of the branch whose tree
matched the worktree, fixtures only. The source and tests are those of commit
`e442824`; this note was added after it.

| What | Result |
| --- | --- |
| Edge suite, `node node_modules/vitest/vitest.mjs run` in `deploy/laterdog/home` | 320 passed, 31 files (main `89b1439`: 312 passed, 31 files). `deploy/laterdog/home/test/desk.test.ts` 45, `deploy/laterdog/home/test/wake-guard.test.ts` 37 |
| `tsc --noEmit` in `deploy/laterdog/home` | exit 0. It reads the edge source only, so the edge tests are run but not type-checked by any gate. `worker-configuration.d.ts` was copied from an earlier lane's `wrangler types` run on the same Worker config; `wrangler types` was not run again |
| `scripts/no-comments.test.ts`, `scripts/brand-links.test.ts`, `scripts/testing/verification-docs.test.ts` | 23 passed, 3 files |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | 0 warnings, 0 errors |
| The one-line removals in the table above | each fails as listed |

Not run: the whole repository test suite, anything on a Mac or a phone, a real
home, the deployed edge.

## Still open

- Nothing here was tried against a real home, the deployed edge or a real
  Worker runtime. The call between a home's two sizes runs in the tests as a
  plain method call on the fake.
- N1 is narrowed, not closed (above).
- A new device can still be kept waiting for its first check by four checks of
  made-up sessions (above).
- From the first review of #167, unchanged: a browser that still carries an
  older session cookie under another name for the same host is not confirmed.
