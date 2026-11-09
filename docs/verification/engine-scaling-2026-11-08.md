# Engine placement and native shell guarding, 2026-11-08

## Completed guard and baseline triage

The home shell guard previously covered Claude only. Native Codex Full Access does not request shell approval, so guarding approval requests could not prevent a heavy command. The runtime now installs a root-managed Codex PreToolUse hook in /etc/codex/requirements.toml. The driver gives each guarded turn its scoped hook URL and a private token file, using the existing hook endpoint and heavy-command classifier. It does not change accounts, models, effort or approval policy. The first recognized heavy command is denied with run_on_computer guidance; a repeat within thirty minutes allows the existing fallback.

The implementation uses the documented [native Codex hook interface](https://learn.chatgpt.com/docs/hooks), including managed requirements and Bash coverage for unified exec. It does not bypass trust for project or plugin hooks. The helper remains bounded and fails open when the home cannot answer, as the existing Claude helper does.

The pinned Linux Codex in laterdog-cloud-home:latest passed scripts/verify-codex-heavy-guard.mjs with the real managed requirements and packaged helper: two native hooks, one denial before execution, and one repeated command executed under Full Access. A loopback synthetic Responses service supplied the commands; no live provider, account credential or live conversation was used. The fixture checked the marker was absent after denial and present after the repeat. This qualifies the native hook mechanism, not a production provider turn.

Before the last driver regression was added, 245 tests passed across the driver, helper, classifier and environment preparation. The final driver and environment-preparation rerun passed 231 tests, including the added check that a guarded native Full Access turn receives its scoped hook file and never puts its authority on argv. Server typechecking and focused lint passed. Comment and brand/link checks passed 13 tests.

The twelve earlier server failures were triaged against current main:

- Six managed-desktop-cleanup fixture failures: its VM context omitted the imported endsSentWork helper, and its source extraction accidentally included the newer provider reload scheduler. The fixture now supplies the real helper and stops at the reload function boundary. All 17 cleanup tests passed.
- Four cloud-start fixtures: their 20/30-second waits expired while production deliberately retried passing startup failures for up to 150 seconds. The fixtures now set a one-second startup budget and retry pause, making their immediate permanent-refusal scenarios deterministic without changing production timing. The place, surface-pin and cloud-start checks passed 17 tests.
- Usage-ledger prompt text and computer size projection: already fixed by merged main. The owner/phone usage fixture and safe computer identity/size checks passed in the initial five-file rerun. The original usage-ledger failure was a real prompt-retention regression; it is not classified as an environment failure.

The original five-file set comprised 47 tests. Its initial rerun passed 43, with only the four cloud retry waits remaining; the corrected cloud fixtures passed afterward. None of the twelve failures is being dismissed as environment-only. The fresh full server run then finished with 9,633 tests passed, 20 skipped and 2 failed. Both failures, in `server/control-laterdog.test.ts` and `server/verification-fixture.e2e.test.ts`, were real fixture isolation bugs, not environment noise. The sealed fixture put Node's own folder on PATH, and nvm installs global CLIs such as `codex` beside `node` (on the Mac, Node 24.6.0 has `codex` and `claude` there), so the fixture discovered ChatGPT. The fixture now gets a private folder that holds only a link to the running Node (`sealedFixtureBin` in `scripts/control-laterdog.ts`), and the regression test scans Node's folder too. On Node 24.6.0 the old code fails that test and the new code passes it. The 99 fixture-backed test files then passed: 401 tests, 2 skipped.

## Read-only baseline

An authenticated read using the desktop app's existing owner session via scripts/cloud-access.ts returned health and storage HTTP 200 at 2026-11-09T02:58:31.733Z. Disk free was 2,404,110,336 of 19,228,708,864 bytes. Available memory was 10,794,643,456 of 12,808,597,504 bytes. The log-only archive was enabled, with zero files/bytes since restart. This is a baseline, not a measurement of engine migration savings.

## Codex guard activation (read on the home, 2026-11-09T03:48Z)

These were read directly inside the running home, not from the deploy log:

- `/app/cloud/build` is `01b206ee2`.
- `/etc/codex/requirements.toml` has sha256 `f50ba8fb…dc8e2`, identical to `deploy/laterdog/home/codex-requirements.toml`.
- `/app/dist-server/hooks/laterdog-hook.js` and the running dev-code bundle's hook are byte-identical (`dfd13b01…6e58`).
- The running server bundle (`/tmp/laterdog-dev-server/6f61e597783bfe3b`, index sha256 `88a79682…cd2f`) contains the Codex hook-token preparation.
- Codex CLI is 0.163.0.
- The large home application `laterdog-home-cloudhomehostlarge` (12 GiB) runs image `sha256:e64ff59e…de42`, the digest pinned in `wrangler.production.json`.

The guard was not redeployed.

## Engine relocation

A dog listed in `<data>/remote-engines.json` (`{"bots": ["<bot id>"]}`) or in `LATERDOG_REMOTE_ENGINE_BOTS` runs its Claude engine on its own cloud computer. Every other dog, and every Codex engine, stays on the home.

- The computer mirrors the home's absolute paths (made with `sudo install -d` for the computer's dog user). The working folder, `CLAUDE_CONFIG_DIR` and the native session file `projects/<slug>/<session>.jsonl` have the same paths on both. Account, model, effort and session flags pass through unchanged. The same Claude Code version is installed on the computer from npm once.
- MCP servers and hooks run on the home, with the home's environment and secrets. The engine sees only `engine-proxy` commands, which carry bytes back over the relay. Hook token files, MCP header and config secrets, and `ELECTRON_RUN_AS_NODE` are removed from the engine's environment. The computer gets the account's access token without its refresh token, and gets it again whenever the home's copy changes.
- Files go out before launch, without packages or build output, and come back at each checkpoint. The relay checkpoints before it forwards a turn's result and before a home tool call, so the home has the files when it sees completion. A newer home edit is never overwritten.
- The engine falls back to the home only when the remote launch surely did not start: the computer could not be prepared, the relay never became ready, or the relay refused to spawn. Once the launch frame is sent and no answer arrives, the turn fails with an explicit error instead of running twice. When the connection drops, the process stream stops the engine. A per-chat lock refuses a second engine for a chat whose engine still runs. When an engine's relay is gone, the next start for that chat stops the orphaned engine first.
- The home's heavy-command guard is left off engines already on their computer.

The code is in `server/laterdog/engine-{remote,placement,computer,opener,relay,proxy,files}.ts`, `deploy/laterdog/computers/src/process-stream.ts`, and the computers Worker's `process` route. A WebSocket cannot cross a Durable Object RPC, so the upgrade goes through the computer object's fetch. The live check found that problem, and `a6ed663ca` fixes it.

These tests pass:

- 8 end-to-end transport tests (`server/laterdog/engine-remote.e2e.test.ts`). They cover a remote turn with a home MCP server and hook, checkpoint before completion, package reuse in a new session, and return to the home on the same session. They also cover Stop, a crash, a connection lost after launch (no re-run, orphan stopped), fallback before dispatch, an unanswered launch (no re-run), and the busy lock.
- 6 planner and stream tests.
- A driver-level test: a chosen dog's Claude turn runs remotely with the same model, effort and session, and an unchosen dog stays on the home.
- 4 process-stream tests in the computers Worker (425 Worker tests in all).
- The Claude and Codex driver suites (496 tests).

Typecheck and lint also pass.

The computers Worker `laterdog-computers` was released as version `ea3e32fa-0df7-4106-8b9a-495e378789cc`. It was a Worker-only deploy (`--containers-rollout=none`), with the image pin unchanged. A computer object keeps its old code until it is evicted, so the live computer picked up the new route only after it had slept for two minutes.

### Live check on a real computer (2026-11-09T04:34Z and 04:4xZ)

`scripts/verify-engine-computer.ts` was bundled and run on the home with the production relay modules. It used Patch's own account, Patch's own cloud computer (`cmp_n4cksekyrpru`), and the real Claude Code 2.1.316 with model `haiku`.

| Session | Placed | Home engine processes | Computer engine processes | Result |
| --- | --- | --- | --- | --- |
| New session: Bash, then a home MCP tool | computer | 0 | 1 | Bash ran on host `a757719a…` (the home is `cloudchamber`). The home answered the tool call with its secret. 3 hooks ran on the home. |
| Resume on the computer | computer | 0 | 1 | Remembered `made-remotely.txt`. |
| Resume on the home | home | 1 | – | Remembered `made-remotely.txt`. Same session file, 66 lines. |

`made-remotely.txt` and the session file were on the home when each result arrived. Before the route fix, the computer refused the first run's stream (HTTP 500), and all three sessions correctly ran on the home with no remote dispatch. That earlier run was the live fallback case.

### Memory on the home

The check's home-side process tree was sampled every 0.5 s during the third run, along with any home Claude engine in it.

- The home Claude engine for one turn peaked at 268,760 KB RSS (about 262 MiB), consistent with the 230–330 MB per engine seen before. With the engine on the computer, no engine process existed on the home.
- During the remote sessions, the whole home-side tree peaked at 172,880 KB. That tree is the check script itself plus the home MCP server and hooks, which exist in both placements. In production the relay link runs inside the existing server process.
- So each engine moved saves about one engine's RSS, roughly 0.26 GB. This is a per-engine measurement. No home-wide before/after RAM change is claimed, because no dog is moved by default.

### Hardening before more dogs (2026-11-09, branch `kennel/engine-hardening`)

Sign-in renewal during long remote turns. While a dog's engine runs on its computer, the home holds that account's `.credentials.json` in `server/laterdog/engine-renewal.ts`. Once a minute it checks the expiry. When fewer than five minutes are left (the same margin the home gate and the CLI use), it claims the existing refresh gate in `claude-refresh-lock.ts` (new `claim`: wait for any turn already refreshing, then lead so home turns wait for this refresh) and runs the account's own pinned CLI as `claude auth status --json` with the home environment. One renewal runs per account however many engines share it. A failed renewal is retried after two minutes. Nothing is held for engines that stay on the home, and the hold ends when the engine closes. The existing 30-second push then sends the new access token, still without its refresh token.

The CLI behaviour was checked, not assumed, with `scripts/verify-claude-sign-in-renewal.mjs` against the real Claude Code 2.1.316 Linux package. An isolated TLS-intercepting proxy with a private CA stood in for every Anthropic address, so no real account or provider was used. Results:

- With 10 minutes left, `auth status` made no token request.
- With 2 minutes left, and once expired, it made one `refresh_token` grant and saved the new access and refresh tokens. It made no model request.
- A running `-p` stream-json engine given a lent token without a refresh token used the replaced `.credentials.json` on its next request. With 3 minutes left it made no token request and kept using the lent token.

So the computer picks up a renewal without restarting the engine. That makes `auth status` the cheapest non-model refresh. The home only renews on Linux, where the sign-in is a file; a Mac keeps it in the Keychain, and the planner lends nothing there.

The dog's private folder, read-only. `workspaces/<bot id>` is mirrored to the same absolute path on the computer, with `MEMORY.md`, `memory/` and the rest. It is bounded: files over 8 MB are skipped, as are build output (`node_modules`, `dist`, `build` and the others the workspace already skips) and symbolic links. The total stops at 64 MB. It is left out when it would overlap the working folder or the account folder. A working folder inside it is excluded from it. Its files arrive without write permission and the folder is never a checkpoint output, so nothing written there comes back. Writes still go through MCP tools.

Placement setting. `GET`/`PUT /api/bots/:id/engine-placement` (`server/routes/engine-placement.ts`) reads and sets `{"placement": "computer" | "home"}`. It needs the owner's admin scope and refuses the local-tools token, so a dog cannot move itself. It writes `remote-engines.json` atomically with mode 600 and keeps other dogs and fields. It refuses to rewrite a file it cannot parse. A dog placed by `LATERDOG_REMOTE_ENGINE_BOTS` is reported as `fromEnvironment` and cannot be moved back here. The app has no control for it yet.

Tests (Node 24.22.1, in isolated temporary folders):

- Engine suites on a Linux cloud computer: 57 tests in 8 files. That is 11 end-to-end transport tests, 3 of them new: the bot folder is mirrored read-only with its bounds; a near-expiry sign-in is renewed on the home during a long remote turn and reaches the computer without its refresh token; and no renewal is held for an engine that fell back to the home. The rest are 11 planner tests (3 new: bot-folder root rules, renewal input, atomic placement file), 7 file tests (1 new: bounded inventory), 5 new renewal tests, 4 new route tests, 10 refresh-gate tests and 9 trim tests. The end-to-end file passed 11/11 in each of three runs.
- The renewal tests cover these cases. It runs only within five minutes of expiry, and only while a remote engine holds the account. It waits for a home turn already refreshing and never refreshes after it. It holds home turns back while it refreshes. It renews once per account, takes over after a home turn's refresh fails, and backs off after its own failure. It runs `auth status --json` in the account folder.
- The route tests cover these cases. It needs admin scope. The local-tools token, unknown dogs, malformed bodies and other methods are refused and change nothing. An unreadable file is left untouched. An environment-placed dog cannot be moved back.
- Claude and Codex driver suites: 16 files, 600 passed and 1 skipped under load. One Codex sign-out test (`blocks new ChatGPT turns and sign-in while active tasks stop and credentials revoke`) failed on a spawn count in that run. Alone it passed on this branch and on main, and `codex.test.ts` then passed all 230 tests. This change does not touch Codex.
- `pnpm typecheck` passed. Lint of the changed files had 0 warnings. Full `pnpm lint` still reports 2 warnings in `electron/shared-computer-access.node-test.mjs`, which exist on main; for that reason the push skipped the pre-push hook. The comment and brand/link checks passed 13 tests. `index-route-ratchet` already fails on main (145 `path === "/` guards against 144); this change adds none.
- On Jacob's Mac (load average about 30), the same unit, route and refresh-gate files passed 37/37. The existing end-to-end case `fails a turn whose connection drops after launch…` failed there 3 of 3 times on main and 3 of 4 times on this branch. The orphan engine had already exited when it was checked. This is a Mac timing problem that predates this change, and it passes on Linux.
- The computers Worker, images and wrangler configs were not changed.

### Not yet done

- Codex engines stay on the home. The app-server's own auth refresh and thread store need their own design.
- A dropped connection ends the turn instead of reattaching to the running engine.
- The placement setting has a server route but no app control.
- Renewal is fixture-qualified, not yet observed on a live account over a real token expiry. The first long remote turn after release should show one `auth status` run in the home's process list and a changed `expiresAt` on both the home and the computer.
- Other home paths outside the working folder, session files, launch files and the bot folder (for example another dog's folder or shared team files) are still not mirrored.

Session/provider archiving and archive deletion remain off. Other dogs were not started and existing worktrees and diffs were preserved.
