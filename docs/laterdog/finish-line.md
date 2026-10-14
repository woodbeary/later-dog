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
| G0 Consolidated | | Every in-flight change committed and pushed; integration branch `laterdog/checkpoint`; this tracker; no-comments check in the phone repo | in progress |
| G1 Phone on production | P0 | Accounts, homes and included AI deployed; the review sign-in reaches a home and a dog replies; the person signs in on their iPhone | waiting on G0 |
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
| L0 Integration | `laterdog/checkpoint` | `/Volumes/laterdog-phone/lanes/checkpoint` | main + #36 + roster + #37 merged | fix the #37 test wording, start CI | CI green |
| L1 Cloud ready | `laterdog/home` | `/Volumes/laterdog-phone/lanes/home` | uncommitted Cloud work committed (`b8831e86a`); image build running | image build green; deploy commands ready | image built, checks green |
| L2 Phone review-ready | `phone/review-ready` (later-dog-phone) | `/Volumes/laterdog-phone/lanes/phone` | not started | data choice before first send; New dog scroll; reconnect fix | proven on the person's iPhone against production |
| L3 Reliability | `laterdog/reliability` | `/Volumes/laterdog-phone/lanes/reliability` | not started | honest handoffs; Keep going across engines; local-tool token | focused tests and fixture proof |
| L4 PR #36 on screen | `laterdog/visual-36` | `/Volumes/laterdog-phone/lanes/visual36` | not started | screenshot every #36 change in a fixture | every item passes on screen |
| L5–L14 | | | wave 2 and 3 | | |

## Evidence

- Archive of every branch tip before this work: kept off GitHub on the person's backup drive.
- Cloud image build: GitHub Actions "Cloud home image" on `laterdog/home`.
