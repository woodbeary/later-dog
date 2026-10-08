# Live acceptance record — started 2026-10-06

This is the running record for the live Codex Cloud acceptance in [verification.md](verification.md). Fixture results are
not repeated here; every line below was observed against real services.

## Hosted supervisor on Cloudflare (prerequisite for step 3)

| Check | Observed | When |
| --- | --- | --- |
| Worker reachable | `GET /healthz` → `ok`; `GET /v1/workspace` without a bearer → `401` | 2026-10-07 05:26Z |
| Container starts through the Worker | `pnpm laterdog:doctor` → `connected: true`, `publishingHost: remote`, Codex CLI `0.154.0` inside, profile `authenticated: false` (device login pending) | 05:26Z (third attempt; the first cold start took ≈ 40 s) |
| Device login mechanism | `pnpm laterdog:login` printed the verification URL and a one-time code from inside the container (unused; expired) | 05:28Z |
| State backup | Worker log: `laterdog state: stored workspace.sqlite (77824 bytes)`, `stored artifacts.tar (10240 bytes)` one minute after a repository was saved | 05:42Z |
| Graceful restart | `POST /admin/restart` → "graceful stop requested" → final backup → "container stopped" 2 s later | 05:42Z |
| Restore after restart | fresh instance: `GET state.r2/workspace.sqlite → 200`; `laterdog:doctor` → `repositories: 1` (the record saved before the restart) | 05:43Z |
| Sleep when idle | watchdog: "no active jobs; the container may sleep" once no job was active | 05:31Z |

Defects found and fixed during this qualification (all in the stacked PRs): the outbound `state.r2` handler was never
registered because a `static outboundByHost` class field shadows the library's static setter (uploads returned 530); the
supervisor's `server.close()` waited forever on the Worker's keep-alive sockets, so a stopped instance lingered for minutes
(fixed with `closeAllConnections()`, a hard-exit timer and a bounded SIGKILL in the entrypoint); `/admin/destroy` added.

## Later the same night (2026-10-07, 06:00–08:00Z)

| Check | Observed | When |
| --- | --- | --- |
| Codex login inside the container | the operator confirmed the device code; `GET /v1/profiles/default/access` → `authenticated: true`, `codex-cli 0.154.0` | 06:20Z |
| Login survives the operator's restart | `POST /admin/restart` at 05:53Z, then the authenticated profile above on the fresh instance (encrypted `codex-auth.json.enc` restored from R2) | 06:20Z |
| Environment IDs | read from the Codex CLI's own environment picker (`codex cloud` → Set Env) driven in a pseudo-terminal: `task-com-ai` = `6a979a5b5bc08191b3a292bcade751f9`, `txtclaw` = `69acb42666848191bb54ebbd34cf8c46` (a `txtclaw` environment already existed; `nextdoor` has none) | 06:40Z |
| Repositories registered | `POST /v1/repositories`: `woodbeary/task-com-ai` (checks `check`) and `woodbeary/txtclaw` (checks `test`; the Vercel checks must also be green), both `generation: unqualified`, `merge: false` | 06:45Z |
| Desktop connection | `~/.laterdog/supervisor.json` saved; `pnpm laterdog:dev` no longer starts a local supervisor when it is present (the operator's `EADDRINUSE` on 9010 was a second local supervisor) | 07:00Z |

Still not done: the `GH_TOKEN` Worker secret. Moving a GitHub credential is the operator's action (the assistant's permission
policy refused it), so `prepare()` — which creates `laterdog/input/<jobId>` on GitHub — cannot run yet, and no job was
submitted. `pnpm laterdog:doctor` now reports `github.authenticated` from inside the container (`gh api user`), so the
state is visible rather than discovered on the first publish.

## Remaining, in order

1. GitHub for the container: `pnpm laterdog:github` (or Workspace → Connect GitHub) starts GitHub's device sign-in inside the
   container and prints a code; the operator enters it at github.com/login/device and authorizes. No token is moved by anyone;
   the login is backed up encrypted and survives restarts. Then `pnpm laterdog:doctor` → `github.authenticated: true`.
2. Steps 1–7 of [verification.md](verification.md#live-codex-cloud-acceptance); environments are registered,
   `generation` stays `unqualified` until the first round trip records which Codex Cloud generation they are.
