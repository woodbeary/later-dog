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
| G0 Consolidated | | Every in-flight change committed and pushed; integration branch `laterdog/checkpoint`; this tracker; no-comments check in the phone repo | done except the phone check, which is L2's first step |
| G1 Phone on production | P0 | Accounts, homes and included AI deployed; the review sign-in reaches a home and a dog replies; the person signs in on their iPhone | deployed: R2 `laterdog-homes`; home image in the Cloudflare registry; computers Worker `011bfbc1`; `laterdog-home` `a8733e4d` with its container application; accounts `a82a3086` on accounts.later.dog. Waiting on the wildcard DNS record and the review sign-in check |
| G2 TestFlight in review | P0 | Build 5 checked on the person's phone through internal testing, then submitted to Beta App Review | waiting on G1 |
| G3 Desktop 0.3.28 | P1 | Keys save; honest handoffs with Continue; Keep going across engines; local-tool token; question cards work; roster across folders; PR #36 checked on screen; sealed install and update pass | waiting on lanes L3, L4 |
| G4 Desktop 0.3.29 with Cloud | P1 | `dev` merged; desktop signs in to Cloud; same dogs on phone and Mac; lending checked through Cloudflare | waiting on G1, G3 |
| G5 Caliber pass | P2 | Chat lines and cards, thinking row, accounts and updates, motion tokens merged with screenshots | waiting on G3 |
| G6 Decision layer and typing suggestions | P3 | Benchmark numbers recorded; suggestions under 300 ms at the median | waiting |
| G7 Dev app, factory, computer tools | P3 | later.dog Dev installs beside the release; one cloud job end to end with screenshots and a saved trace; computer tools answer over MCP | waiting |
| G8 Launch copy | P3 | Site and README lines and the launch post approved by the person | waiting |

## Lanes

| Lane | Branch | Worktree | Status | Next step | Done when |
| --- | --- | --- | --- | --- | --- |
| L0 Integration | `laterdog/checkpoint` (PR #38) | `/Volumes/laterdog-phone/lanes/checkpoint` | main + #36 + roster + #37 merged; #37 test fixed; tracker added | CI on PR #38; merge lane PRs as they land | CI green |
| L1 Cloud ready | `laterdog/home` (PR #39 into dev) | `/Volumes/laterdog-phone/lanes/home` | done: production configs, decisions accept images and a model, optional CI image push, deploy sheet; tests 211 + 39 + 96 green | none | done |
| L2 Phone review-ready | `phone/review-ready` (later-dog-phone) | the phone repo's own checkout (served to the test iPhone) | running | no-comments check; probe fix; live updates recover; data choice before first send; New dog scroll; visual pass; review notes | proven on the test iPhone; production check after G1 |
| L3 Reliability | `laterdog/reliability` | `/Volumes/laterdog-phone/lanes/reliability` | all seven fixes coded with tests; draft PR into `laterdog/checkpoint`; fixture proof recorded in the PR | review the PR; Jacob's live checks: a long dog-to-dog job past 30 minutes, Continue after a time-out, a real Claude-to-Codex continuation, Claude Code and Codex on this Mac using the local-tools token, a full disk | PR merged into `laterdog/checkpoint` and the live checks above pass |
| L4 PR #36 on screen | `laterdog/visual-36` | `/Volumes/laterdog-phone/lanes/visual36` | running | screenshot every #36 change beside its reference; fix; question card works and folds | sheet with every item passing |
| L5–L14 | | | wave 2 and 3 | | |

## Evidence

- Archive of every branch tip before this work: kept off GitHub on the person's backup drive.
- Cloud image build: GitHub Actions "Cloud home image" on `laterdog/home`.
