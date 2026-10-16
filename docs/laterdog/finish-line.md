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
| G1 Phone on production | P0 | Accounts, homes and included AI deployed; the review sign-in reaches a home and a dog replies; the person signs in on their iPhone | done 2026-10-15 01:35 PT: the person chats with their dogs from the phone against their Cloud home |
| G2 TestFlight in review | P0 | Build 5 checked on the person's phone, then submitted to Beta App Review | approved 2026-10-15; public link https://testflight.apple.com/join/UH46TVvC (feedback on, Build 5); later.dog sends iPhone visitors to it |
| G3 Desktop 0.3.28 | P1 | Keys save; honest handoffs with Continue; Keep going across engines; question cards work; roster across folders; PR #36 checked on screen; sealed install and update pass | done 2026-10-14 02:52 PT: released from `3c90fc0e1` (all checks green), notarized; sealed install, voice and the 0.3.27 → 0.3.28 in-place update passed with every data file kept and no change to the real folders (`docs/verification/installed-release-2026-10-14.md`). The local-tools token moved to 0.3.29 |
| G4 Desktop with Cloud | P1 | Account sign-in preserves the current workspace; phone and Cloud execution use its same dogs | done 2026-10-15 in 0.3.34–0.3.39 (Cloud home model): dogs and chats live in the account's Cloud home; desktop and phone are screens onto it and the Mac is a computer the dogs can use; AI sign-ins hand over; apps on the Mac reach the Cloud through the MCP server with local-tools limits; Cloud wakes in about a minute; Codex chats rebuild from the transcript |
| G5 Caliber pass | P2 | Chat lines and cards, thinking row, accounts and updates, motion tokens merged with screenshots | done 2026-10-14 04:50 PT: released in 0.3.29 with #42, #43, #45, #50 (and #46, #47, #52, #53); sealed install, voice, a Kimi reply and the 0.3.28 → 0.3.29 update passed (`docs/verification/installed-release-2026-10-14.md`) |
| G6 Decision layer and typing suggestions | P3 | Benchmark numbers recorded; suggestions under 300 ms at the median | typing suggestions shipped in 0.3.29 (local by default; the cloud path is off until turned on, and its Worker route is not deployed yet). Live Clef benchmark recorded. PR #41 is still fixing its safety review |
| G7 Dev app, factory, computer tools | P3 | later.dog Dev installs beside the release; one cloud job end to end with screenshots and a saved trace; computer tools answer over MCP | not in use; the most important gap: changes were verified against the person's live setup. Next gate N1 below |
| G8 Launch copy | P3 | Site and README lines and the launch post approved by the person | site iPhone launch done 2026-10-15 (branch `site/iphone-testflight` in later-dog-site); hiring line and launch post not started |

## Next gates (2026-10-15)

| Gate | Done when |
|---|---|
| N0 Main is what shipped | PR #63 (`claude/integrate-0334`) merged into `main` with the person's OK; releases come from `main` only |
| N1 Dev loop | later.dog Dev installed beside the release; a test Cloud home on a test account receives every server/home change first; the phone runs in Expo Go against it; Cloud images go from GitHub to Cloudflare without passing through the person's Mac; a first-trip and phone round-trip check passes on the test Cloud before each release |
| N2 Coding in the Cloud | GitHub connected once in the Cloud; dogs clone repos into their own cloud computer and open draft pull requests; Mac-only files go through the Mac connection |
| N3 Phone parity | threads, Continue on another account, AI account sign-in and cloud task actions on the phone; then queued messages, connect-app and secret cards, plan limits, approve from a notification, rooms |
| N4 App Store | submission drafted, the review path passed on a real iPhone, submitted with the person's OK |
| N5 Cloud reliability | the 2026-10-15 01:50 crash explained from the new stop logging; transient copy state kept out of the saved snapshot; memory checked on standard-1 |

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
| L8 Decision layer (Clef) | `laterdog/clef` | #41 | fixing the safety review's findings; live benchmark done |
| L9 Motion and tokens | `laterdog/motion` | #43 | done, on the staging branch |
| L10 Typing suggestions | `laterdog/tab` | #52 (on the staging branch) | done: local suggestions on by default; Smarter suggestions (Cloudflare) off by default; the Worker route `/v1/complete` waits for a deploy from a branch with `laterdog/home`'s computers Worker |
| L11 later.dog Dev | `laterdog/dev-app` | #46 (on the staging branch) | done: Dev shares nothing with the release (data, ports, scheme, companion, container, keychain, updates); two data-safety reviews passed; the person picks an icon (`/Volumes/laterdog-phone/tmp/l11-sheet/index.html`); the first push to `dev` runs its build |
| L12 Factory and computer tools | `laterdog/factory` (L12b) | draft, into `laterdog/cloud-desktop` | L12b done: traces kept in R2, per-job model, account and effort, small default computer, cost and approvals notes (`cloud-jobs.md`, `factory-approvals.md`); computer tools waiting for a slot; one real job still to run |
| L13 Stability sweep | `laterdog/stability` | #53 (on the staging branch) | done: 34-row checklist in `docs/verification/stability-sweep.md`; 21 pass, 9 fixed with tests, 3 with the smallest fix written down, 1 different by design |
| L14 Launch and hiring copy | | | waiting for a slot |
| L15 Desktop follow-up | `laterdog/desktop-polish-oct14`, integrated into `laterdog/release-0330` | #60, #57 | merged into main through #57 as `e2b6dd005` on 2026-10-14: compact progress drawer, opened-thread batches, confirmed peer rename and current-name references. All 11 candidate CI checks passed on `3b3e703de`; release publication and visual verification remain (`docs/verification/desktop-polish.md`) |
| L16 Local hot reload | local `main` | | command ready: `pnpm dev:desktop` starts isolated source services and Electron on Vite; focused tests and HMR protocol edit/undo pass; Mac window verification awaits this conversation's local Computer connection |
| L17 Repeated chat statuses | local `main` | | repeated teammate failures collapse into one consistently red count with individual results; repeated sends collapse across hidden tool calls with each destination retained. Renderer Message now shares the existing wire roomRequest type; full typecheck, lint and 185 focused regression checks pass for both UI fixes. Dev-window screenshot remains blocked by Computer Off (`canSelect: false`) |
| L18 Thread mention chips | local `main` | | inline thread references use compact pills with a thread icon, teammate avatar and truncated label; navigation and full accessible titles retained. 115 focused renderer tests and focused lint pass; Dev-window screenshot remains blocked by Computer Off (`canSelect: false`) |
| L19 Status lines (W9) | `claude/status-lines-1015` | | server posts one "Still on it: …" line after 3 quiet minutes of tool-only work (`server/laterdog/status-lines.ts`), updated in place at most every 3 minutes, folded into the turn's progress when the dog speaks, asks or stops, and folded at boot if a restart left one open; every dog's instructions now ask for a line at each milestone and forbid time estimates. Unit, renderer and fixture tests pass (`status-lines.e2e.test.ts`: reply fold and SIGKILL restart fold). Needs a home image and desktop release; no screenshot yet |

## Notes for whoever picks this up

- After a home image deploy, Cloudflare can keep starting the old image for a few minutes. `wrangler containers instances <app id>` shows the version; wait for the new one before judging a fix.
- A home's Durable Object keeps its old Worker code while its container runs. A Worker deploy reaches a running home only after it sleeps.
- Homes are reached at `h<id>-home.later.dog`, which needs a proxied wildcard record (`*` AAAA `100::`) on later.dog.

## Evidence

- Archive of every branch tip before this work: kept off GitHub on the person's backup drive.
- Cloud image build: GitHub Actions "Cloud home image" on `laterdog/home`.
