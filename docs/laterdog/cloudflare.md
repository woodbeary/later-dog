# later.dog on Cloudflare

The remote publishing supervisor runs as a [Cloudflare Container](https://developers.cloudflare.com/containers/) owned by one
Durable Object, behind a Worker that checks the supervisor bearer token. `deploy/laterdog/cloudflare/` holds the Worker; the
image is the same `deploy/laterdog/Dockerfile` that Compose and the CI smoke test use.

## Grant coverage and budget

Compute for the hosted supervisor is funded by the operator's Cloudflare grant. This document is the explicit budget the
project's paid-backend policy asks for; it covers hosting the *supervisor* only. The Cloudflare *runner* backend stays disabled
until its own submit → inspect → collect → PR → verify → correction round trip is qualified separately.

| Item | Rate (Workers Paid) | Monthly estimate |
| --- | --- | --- |
| Workers Paid plan | $5/month | $5.00 |
| Container `standard-3` (2 vCPU, 8 GiB, 16 GB) running 24/7, memory | $0.0000025 per GiB-second beyond the included 25 GiB-hours | ≈ $52 |
| Container disk, 16 GB, 24/7 | $0.00000007 per GB-second beyond the included 200 GB-hours | ≈ $3 |
| Container CPU at ~10% average use | $0.000020 per vCPU-second beyond the included 375 vCPU-minutes | ≈ $10 |
| R2 state bucket (`laterdog-state`, a few MB, backups every minute when changed) | $0.015 per GB-month; 10 GB and 1M class A operations free | ≈ $0 |
| Durable Object requests | within the included allowance | $0 |
| **Total if it ran 24/7** | | **≈ $70/month (≈ $845/year)** |

The container does **not** run 24/7: it sleeps after 15 idle minutes and the cron watchdog only keeps it awake while jobs
are in flight (a request that creates or acts on a job marks the Durable Object "active"; the watchdog clears the flag when
the supervisor reports zero active jobs). Memory and disk are billed per running second, so idle hours cost nothing beyond the
plan fee. At 8 busy hours a day the estimate is ≈ $27/month; at 2 hours ≈ $10/month. `POST /admin/wake` wakes it on demand;
any request through the Worker wakes it implicitly (a cold start takes a few seconds plus the state restore).

Sensitivity for the 24/7 figure: 5% CPU ≈ $65, 25% ≈ $86, 100% ≈ $165. A custom 2 vCPU / 6 GiB instance is ≈ $56; `standard-1` ≈ $37.

A personal grant does not provide free compute to other users of later.dog; they deploy this Worker into their own account.

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| Worker (`deploy/laterdog/cloudflare/src/index.ts`) | Cloudflare edge | Bearer check (the admin token, or a dog's derived token for `/v1/*` only, which the supervisor then scopes), `/admin/restart`, `/healthz`, cron watchdog every 5 minutes, `state.r2` virtual host |
| `SupervisorHost` Durable Object + container | one `standard-3` instance | Sleeps after 15 idle minutes; kept awake by the watchdog only while jobs are active; woken by any request or `POST /admin/wake` |
| Supervisor state | R2 bucket `laterdog-state`, prefix `latest/` | `workspace.sqlite`, `config.json`, `artifacts.tar`, encrypted `codex-auth.json.enc` |
| Codex login | inside the container, as user `node` | `pnpm laterdog:login` starts `codex login --device-auth`; the operator confirms in a browser |
| GitHub access | GitHub's device sign-in run inside the container (`pnpm laterdog:github` or Workspace → Connect GitHub), backed up encrypted as `gh-hosts.yml.enc`; or a fine-grained PAT as Worker secret `GH_TOKEN` | `gh auth setup-git` makes `git push` use it |
| Desktop / workspace server | the operator's machine (always-on workspace server later) | `~/.laterdog/supervisor.json` (`url` + `tokenFile`), or `LATERDOG_SUPERVISOR_URL` + `LATERDOG_TOKEN_FILE` |

The container's disk is ephemeral: Cloudflare restarts hosts on an irregular cadence, sends `SIGTERM`, waits up to 15 minutes,
then kills the instance, and the next start has a fresh disk. `deploy/laterdog/entrypoint.sh` therefore restores the state
listed above on boot and uploads whatever changed every minute and on `SIGTERM`. Publishing checkouts are a cache and are
re-cloned on demand. The Codex `auth.json` is encrypted with `LATERDOG_BACKUP_KEY` before it leaves the container; never run the
same `auth.json` on two machines — the CLI rotates its refresh token.

## First deployment

Prerequisites (one-time): Workers Paid on the account, R2 enabled, a running Docker engine on the deploying machine (the image is
built locally for `linux/amd64` and pushed to Cloudflare's registry), and `wrangler` logged in with `containers` and `r2` scopes.

```sh
cd deploy/laterdog/cloudflare
pnpm install --frozen-lockfile --ignore-workspace
pnpm exec wrangler whoami                      # scopes must include containers and r2
pnpm exec wrangler r2 bucket create laterdog-state
```

Set the three required secrets **before** the first deploy. Worker secrets become the container's environment at start; a secret
changed later reaches the container only after `/admin/restart`.

```sh
mkdir -p ~/.laterdog
openssl rand -base64 48 | tr -d '\n' | tee ~/.laterdog/supervisor-token | pnpm exec wrangler secret put LATERDOG_TOKEN
chmod 600 ~/.laterdog/supervisor-token
openssl rand -base64 32 | tr -d '\n' | pnpm exec wrangler secret put LATERDOG_BACKUP_KEY
# GitHub: nothing to paste. After the deploy, `pnpm laterdog:github` (or Workspace → Connect GitHub) prints a code from
# GitHub's device sign-in running inside the container; enter it at github.com/login/device and authorize.
# Stricter alternative: pnpm exec wrangler secret put GH_TOKEN  # a fine-grained PAT: Contents RW, Pull requests RW, Checks R, Commit statuses R, Metadata R
pnpm exec wrangler deploy
```

`wrangler` needs Node 22 or newer: run `nvm use` in the repository first (its `.nvmrc` selects Node 24).

Then save the connection the desktop will use, sign the container's Codex profile in, and confirm:

```sh
cat > ~/.laterdog/supervisor.json <<'EOF'
{ "url": "https://laterdog-supervisor.<account>.workers.dev", "tokenFile": "~/.laterdog/supervisor-token" }
EOF
pnpm laterdog:login      # prints the verification URL and code; confirm in a browser (device-code login must be enabled in ChatGPT settings)
pnpm laterdog:doctor     # profile.authenticated and github.authenticated must be true; publishingHost must be remote
```

With that file present, `pnpm laterdog:dev` and a Finder-launched packaged app start no local supervisor and talk to the hosted one;
`LATERDOG_SUPERVISOR_URL` + `LATERDOG_TOKEN_FILE` in the environment override it. `github.authenticated: false` means the
`GH_TOKEN` secret is missing or was set after the container started — set it, then `/admin/restart`.

## Operations

- **Restart with state:** `curl -X POST -H "Authorization: Bearer $(cat ~/.laterdog/supervisor-token)" $LATERDOG_SUPERVISOR_URL/admin/restart` — the entrypoint takes a final backup on `SIGTERM`; the next request or cron tick starts a fresh instance that restores it. Restart while jobs are `running`, not while one is `publishing` or `verifying` (recovery moves those to `needs_attention`).
- **Logs:** `pnpm exec wrangler tail laterdog-supervisor` in `deploy/laterdog/cloudflare`; the watchdog logs an error whenever the Codex profile reports `authenticated: false` (a stale restored token needs `pnpm laterdog:login` again).
- **Secrets rotation:** `wrangler secret put …` then `/admin/restart`. Rotating `LATERDOG_TOKEN` also rotates every dog token; a dog receives its new one when its `laterdog` MCP server next starts.
- **Dog tokens:** each bot presents its own derived token ([what it reaches](deployment.md#what-a-dogs-token-reaches)). Deploy the Worker and the container image that know dog tokens *before* running a desktop that issues them against this supervisor: an older Worker or container answers a dog's token with 401. The admin token works in either order.
- **Bridges:** `/v1/bridge/*` passes through without the admin bearer so a paired Mac can poll with its own device token.
- **Wake-ups:** the desktop's pull (`POST /v1/wakeups/pull`) is answered by the Worker itself, with nothing to deliver, while no
  work is in flight and the supervisor's last report (`x-laterdog-wakeup-bots`, kept in the Durable Object) names none of that
  desktop's dogs, so polling never wakes a sleeping container. Otherwise the supervisor answers, waking the container if it must.

## Limitations recorded for the acceptance run

- No persistent volume: everything not in the backup set is lost on restart. Backups run every minute when changed, so an
  unclean stop can lose up to a minute of job events; the supervisor's `requestKey` idempotency and `submission_unknown` handling
  are what prevent duplicate cloud submissions after such a loss.
- Verification command recipes (`verify.Dockerfile`) cannot run here: the container has no Docker. Use real GitHub checks via
  `behavioralChecks`.
- Wake-ups reach a conversation only while its desktop runs. The supervisor cannot call a desktop, so the desktop pulls its
  dogs' wake-ups every 30 s and settles each one ([wakeups.ts](../../server/laterdog/wakeups.ts)); a Mac that slept through a job
  gets them when it is back. Nothing keeps a conversation thinking in the cloud meanwhile: there is no always-on workspace server.
- Cloudflare Sandbox runners for agents document API-key billing only; a subscription-billed runner is not qualified, so the
  `cloudflare-sandbox` backend stays disabled.
