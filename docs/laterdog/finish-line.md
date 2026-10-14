# Finish line: desktop, iPhone and Cloud

Started 2026-10-13. This file is the single place that says what is in progress, what is done, and how to pick up any piece of it. Every gate updates it in the same commit as the work.

## How to resume

1. Read `AGENTS.md`. The rules there hold for every lane: pnpm, Node 24, no comments in code, new behaviour in new files under `server/laterdog/`, isolated fixtures only.
2. Find your lane below. Check out its branch in its own worktree. Never switch branches in someone else's worktree.
3. Never touch the person's live data folder or the running app on port 8799. UI evidence comes from `scripts/control-laterdog.ts ui launch` and `ui screenshot` against a fixture.
4. Never deploy, merge to `main`, publish a release or type a secret. Those wait for the person's own yes.
5. Commit and push at every green step, and update your lane's row here.
6. Before every commit, run the no-comments check:
   - later-dog: `pnpm exec vitest run scripts/no-comments.test.ts`
   - later-dog-phone: `pnpm test -- no-comments`

## Priorities

- **P0:** the iPhone app works against production, and the TestFlight build is in Beta App Review.
- **P1:** fixes that stop daily use of the desktop app.
- **P2:** polish to the reference caliber.
- **P3:** decision layer, typing suggestions, side-by-side Dev app, cloud job factory, launch copy.

Work stops at a gate before the next one starts.

## Gates

| Gate | Priority | Done when | State |
| --- | --- | --- | --- |
| G0 Consolidated | | Every in-flight change committed and pushed; integration branch `laterdog/checkpoint`; this tracker; no-comments check in the phone repo | done |
| G1 Phone on production | P0 | Accounts, homes and included AI deployed; the review sign-in reaches a home and a dog replies; the person signs in on their iPhone | done 2026-10-14 00:52 PT for the review account: fresh home ready in 11 s, real AI answer in 8 s. Fixes deployed since: the review address may ask for a code 20 times in 15 minutes (`7141d56fc`); a phone that kept the last sign-in's cookie can sign in again (`8ef743ca1`, accounts `aeeef844`). Waiting on the person: the full reviewer-path check (`/Volumes/laterdog-phone/tmp/reviewer-path-check.mjs`) and their own sign-in on the phone |
| G2 TestFlight in review | P0 | Build 5 checked on the person's phone, then submitted to Beta App Review | submitted 2026-10-14 00:46 PT, waiting for review. Lesson: it was submitted before a real-device run; never again. Phone `main` has `2341bf6` (in the app while the home starts) and `9d47bec` (no account cookies) for an over-the-air update after approval |
| G3 Desktop 0.3.28 | P1 | Keys save; honest handoffs with Continue; Keep going across engines; question cards work; roster across folders; PR #36 checked on screen; sealed install and update pass | done 2026-10-14 02:52 PT: released from `3c90fc0e1` (all checks green), notarized; sealed install, voice and the 0.3.27 → 0.3.28 in-place update passed with every data file kept and no change to the real folders (`docs/verification/installed-release-2026-10-14.md`). The local-tools token moved to 0.3.29 |
| G4 Desktop with Cloud | P1 | `dev` merged; desktop signs in to Cloud; same dogs on phone and Mac; lending checked through Cloudflare | `dev` and `laterdog/home` merged onto the staging branch in PR #49 (CI running). Live sign-in and moving dogs need the person's account, so they wait for the morning before shipping |
| G5 Caliber pass | P2 | Chat lines and cards, thinking row, accounts and updates, motion tokens merged with screenshots | done 2026-10-14 04:50 PT: released in 0.3.29 with #42, #43, #45, #50 (and #46, #47, #52, #53); sealed install, voice, a Kimi reply and the 0.3.28 → 0.3.29 update passed (`docs/verification/installed-release-2026-10-14.md`) |
| G6 Decision layer and typing suggestions | P3 | Benchmark numbers recorded; suggestions under 300 ms at the median | typing suggestions shipped in 0.3.29 (local by default; the cloud path is off until turned on, and its Worker route is not deployed yet). Live Clef benchmark recorded. PR #41's safety review findings are fixed and it awaits re-review |
| G7 Dev app, factory, computer tools | P3 | later.dog Dev installs beside the release; one cloud job end to end with screenshots and a saved trace; computer tools answer over MCP | Dev app code shipped in 0.3.29 (its own build runs on the first push to `dev`, and the person picks an icon); computer tools (L12a) and factory (L12b) in progress |
| G8 Launch copy | P3 | Site and README lines and the launch post approved by the person | waiting for a slot (L14) |

## Lanes

| Lane | Branch | PR | Status |
| --- | --- | --- | --- |
| L0 Integration | `laterdog/checkpoint`, staging `laterdog/next` | #38, #48, #49 | 0.3.28 on `laterdog/checkpoint`; 0.3.29 staged on `laterdog/next` |
| L1 Cloud ready | `laterdog/home` | #39 | done; tonight's Cloud fixes also on #49 |
| L2 Phone review-ready | later-dog-phone `main` | | done |
| L3 Reliability | `laterdog/reliability`, `laterdog/local-tools-token` | #44 (merged), #47 (on the staging branch) | done: token is a default-deny allow-list, re-reviewed, N1-N5 fixed with e2e tests |
| L4 PR #36 on screen | `laterdog/visual-36` | #40 (merged) | done |
| L5 Chat lines and cards | `laterdog/chatlines` | #50 (on the staging branch) | done: quiet dog-to-dog lines and exchange view, routine line, mentions with faces, renames everywhere, approvals fold; safety review fixed (Allow once primary, Don't allow, Always allow outlined) |
| L6 Thinking, scroll, sidebar | `laterdog/thinking` | #45 | done, on the staging branch |
| L7 Accounts, usage, update | `laterdog/accounts-ui` | #42 | done, on the staging branch; two choices for the person (model menu limited to the account in use; accounts that need an approval greyed in Switch account) |
| L8 Decision layer (Clef) | `laterdog/clef` | #41 | safety review's 13 findings fixed with tests, rebased on 0.3.29; the four jobs are off until switched on; live benchmark recorded in `docs/decision-model.md`; which 3 of 30 auto-review verdicts were wrong is unknown until the bench is rerun with `--only autoReview`; no live acceptance record yet |
| L9 Motion and tokens | `laterdog/motion` | #43 | done, on the staging branch |
| L10 Typing suggestions | `laterdog/tab` | #52 (on the staging branch) | done: local suggestions on by default; Smarter suggestions (Cloudflare) off by default; the Worker route `/v1/complete` waits for a deploy from a branch with `laterdog/home`'s computers Worker |
| L11 later.dog Dev | `laterdog/dev-app` | #46 (on the staging branch) | done: Dev shares nothing with the release (data, ports, scheme, companion, container, keychain, updates); two data-safety reviews passed; the person picks an icon (`/Volumes/laterdog-phone/tmp/l11-sheet/index.html`); the first push to `dev` runs its build |
| L12 Factory and computer tools | | | waiting for a slot |
| L13 Stability sweep | `laterdog/stability` | #53 (on the staging branch) | done: 34-row checklist in `docs/verification/stability-sweep.md`; 21 pass, 9 fixed with tests, 3 with the smallest fix written down, 1 different by design |
| L14 Launch and hiring copy | | | waiting for a slot |

## Notes for whoever picks this up

- After a home image deploy, Cloudflare can keep starting the old image for a few minutes. `wrangler containers instances <app id>` shows the version; wait for the new one before judging a fix.
- A home's Durable Object keeps its old Worker code while its container runs. A Worker deploy reaches a running home only after it sleeps.
- Homes are reached at `h<id>-home.later.dog`, which needs a proxied wildcard record (`*` AAAA `100::`) on later.dog.

## Evidence

- Archive of every branch tip before this work: kept off GitHub on the person's backup drive.
- Cloud image build: GitHub Actions "Cloud home image" on `laterdog/home`.
