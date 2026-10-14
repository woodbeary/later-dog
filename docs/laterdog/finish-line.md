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
| G1 Phone on production | P0 | Accounts, homes and included AI deployed; the review sign-in reaches a home and a dog replies; the person signs in on their iPhone | done 2026-10-14 00:52 PT: the review check signs in, starts a fresh home (ready in 11 s), pairs over the wildcard record, makes a dog and gets a real AI answer in 8 s. Fixes on the way: seeded services adopted by a new home, a code request wakes the home, the review address may ask for a code 20 times in 15 minutes (`7141d56fc`). The person's own sign-in on the phone is still to try |
| G2 TestFlight in review | P0 | Build 5 checked on the person's phone through internal testing, then submitted to Beta App Review | submitted 2026-10-14 00:46 PT, waiting for review. External group "later.dog beta"; Test Information and review details set. Build 5 holds `later-dog-phone` `66920e4`; `2341bf6` (in the app while the home starts) waits for an over-the-air update after approval |
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
| L1 Cloud ready | `laterdog/home` (PR #39 into dev) | `/Volumes/laterdog-phone/lanes/home` | done, plus fixes after deploy: seeded services adopted (`1a2ddb4b1`), code request wakes the home (`013bfa1ff`), image pin (`4362e2de1`) | none | done |
| L2 Phone review-ready | `phone/review-ready` → `main` (later-dog-phone, `e174c57`) | the phone repo's own checkout | done: no-comments check, probe fix, live updates recover, data choice before the first send, New dog scrolls, visual pass, Terms and Privacy on sign-in, no plan row; 190 tests; published over the air to `beta` (`857e9992`) | Build 5 and the review submission at G2 | done |
| L3 Reliability | `laterdog/reliability` (PR #44, token-free) and `laterdog/local-tools-token` | `/Volumes/laterdog-phone/lanes/reliability` | six fixes in PR #44; the local-tools token is redone as a default-deny allow-list built from the scripts' real requests, on its own branch and draft PR (based on #44) | PR #44 merged; token PR reviewed again by the security pass | #44 and the token PR merged into `laterdog/checkpoint`; live checks: a long dog-to-dog job past 30 minutes, Continue after a time-out, a real Claude-to-Codex continuation, a full disk, the scripts on the installed app |
| L4 PR #36 on screen | `laterdog/visual-36` (PR #40, merged) | `/Volumes/laterdog-phone/lanes/visual36` | done: every #36 change screened beside its reference; questions one at a time with Next and Back, folded answers; account menu, progress peek and model button aligned | none | done |
| L6 Thinking, scroll, sidebar | `laterdog/thinking` | `/Volumes/laterdog-phone/lanes/thinking` | running | one thinking row, fewer bubbles, green dot, NEW divider and new-messages pill, sidebar collapse, copy id | sheet beside the reference |
| L7 Accounts, usage, update | `laterdog/accounts-ui` | `/Volumes/laterdog-phone/lanes/accounts` | running | battery rows, account menu usage, add account in place, model never switches account, quiet update pill | sheet beside the reference |
| L8 Decision layer (Clef) | `laterdog/clef` | `/Volumes/laterdog-phone/lanes/clef` | running | auto-review rules, finished-or-stopped check, screen check, screenshot filter, benchmark | benchmark numbers |
| L5, L9–L14 | | | waiting for slots | | |

## Notes for whoever picks this up

- After a home image deploy, Cloudflare can keep starting the old image for a few minutes. `wrangler containers instances <app id>` shows the version; wait for the new one before judging a fix.
- A home's Durable Object keeps its old Worker code while its container runs. A Worker deploy reaches a running home only after it sleeps.
- Homes are reached at `h<id>-home.later.dog`, which needs a proxied wildcard record (`*` AAAA `100::`) on later.dog.

## Evidence

- Archive of every branch tip before this work: kept off GitHub on the person's backup drive.
- Cloud image build: GitHub Actions "Cloud home image" on `laterdog/home`.
