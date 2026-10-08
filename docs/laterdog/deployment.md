# Deployment and account setup

The supervisor stores jobs, repository policy, attempts, immutable input refs, provider task identities, output branches, PR heads, evidence, decisions, pairing hashes and completion notifications in SQLite. Its artifact directory and Git checkouts must share the persistent state volume. Back up the whole private state directory with SQLite's backup API or while the service is stopped; copying a live database without WAL is incomplete.

## Remote supervisor on Cloudflare

The supported hosted option is a Cloudflare Container; see [cloudflare.md](cloudflare.md) for the budget, the secrets that must
exist before the first deploy, the in-container `codex login --device-auth` flow (`pnpm laterdog:login`), restarts and backups.

## Remote supervisor on a Docker host

On an owned remote host with Docker:

```sh
mkdir -p deploy/laterdog/profiles deploy/laterdog/github
chmod 700 deploy/laterdog/profiles deploy/laterdog/github
docker compose -f deploy/laterdog/compose.yml build
docker compose -f deploy/laterdog/compose.yml up -d
```

The image pins the native Codex CLI to 0.154.0. It does not copy the developer's local credentials. Authenticate your own Codex account with its supported device login inside the remote service (`docker compose -f deploy/laterdog/compose.yml exec supervisor codex login --device-auth`) and GitHub with `gh auth login`. Volume ownership must permit container user `node` (UID 1000); grant only those mounted directories to it. GitHub access must cover the connected repository's input refs, result branches and PRs. Merge access is separately granted by repository policy and remains subject to branch protections.

The Compose port binds only remote loopback. Access it through an authenticated SSH tunnel, Tailscale arrangement, or HTTPS reverse proxy. Do not expose an unauthenticated plain HTTP listener publicly. SQLite and pairing tokens do not belong in source control.

The generated `/var/lib/laterdog/access-token` is private. Transfer only this service credential to the authorized workspace server's private token file, not to browser code. Then tell the desktop where its supervisor is, either with environment variables:

```sh
LATERDOG_SUPERVISOR_URL=https://your-supervisor.example
LATERDOG_TOKEN_FILE=/absolute/private/laterdog-token
```

or, so a packaged app launched from Finder and a plain `pnpm laterdog:dev` find it without any variables, by saving `~/.laterdog/supervisor.json` (beside the local supervisor's own `supervisor/` directory):

```json
{ "url": "https://your-supervisor.example", "tokenFile": "~/.laterdog/supervisor-token" }
```

Environment variables win over the file. While either is present the desktop starts no local supervisor, the Workspace, the `laterdog` MCP tools and `pnpm laterdog:doctor` all talk to the hosted one, and a missing token file is reported as such rather than silently producing 401s. For an SSH tunnel use the loopback HTTP origin instead. A native remote host can run `pnpm laterdog:supervisor` with `LATERDOG_PUBLISHING_HOST=remote`; that setting is an operator assertion about placement, not hardware attestation. The service must actually run remotely.

The desktop-owned supervisor defaults to local and refuses repository publishing/verification. To run heavy verification, use a native remote supervisor with Docker installed. The supplied supervisor container intentionally has no Docker socket mount: mounting it would give repository commands control of the host. With that container, configure the names of actual behavioral GitHub CI checks (in the Workspace, or from an agent connected with the admin token through configure_verification_recipe, which cannot change merge authority; a dog's own token cannot change them), or configure a separately isolated container runtime before adding command verification. `verify.Dockerfile` is a starting image; target-specific offline dependencies are required because verifier commands run with networking disabled.

## Multiple accounts

Private `config.json` inside the supervisor state directory:

```json
{
  "concurrency": 4,
  "publishingHost": "remote",
  "profiles": [
    { "id": "personal", "label": "Personal Codex", "codexHome": "/private/codex-personal" },
    { "id": "work", "label": "Work Codex", "codexHome": "/private/codex-work" }
  ],
  "workspaceUrl": "https://your-always-on-workspace.example",
  "workspaceTokenFile": "/private/workspace-access-token"
}
```

Log each profile in using the provider's supported workflow and separate credential directory. The adapter strips API keys and uses the selected native subscription profile; it never silently switches to API billing. The UI exposes labels, not credential paths or tokens. Allowance information is unknown until a supported provider endpoint proves it; multiple profiles do not increase provider limits by assumption.

## Persistent conversational supervision

Run the later.dog workspace server (`laterdog serve`) on an always-on host as well as the supervisor. Configure `workspaceUrl` plus its private bearer token file so completion outbox events return to the original bot and conversation with a stable send ID. After an uncertain callback, the exact same ID is retried and the workspace's existing idempotency layer deduplicates it. The coordinator agent inspects the durable job and chooses the next action. The desktop need not remain connected.

Use the app's remote-server connection (Settings) to view that workspace. Conversation engines run on the host that owns that server. Merely choosing a remote execution backend does not relocate a locally hosted coordinator bot.

## What a dog's token reaches

Each bot ("dog") reaches the supervisor through its built-in `laterdog` MCP server, which the desktop starts with that dog's own token, never the admin token: `base64url(HMAC-SHA256(admin token, "laterdog-dog:<bot id>"))`, sent with `X-LaterDog-Bot: <bot id>` (`server/laterdog/dog-access.ts`). The supervisor and the Cloudflare Worker recompute it from the admin token they already hold, so nothing new is stored, and the admin token is also kept out of every engine's inherited environment. The Workspace, `pnpm laterdog:doctor`, `pnpm laterdog:login`, `pnpm laterdog:github` and an operator's own `pnpm laterdog:mcp` send no bot header and keep the admin token's full access.

A dog's token reaches only what its tools call: delegating jobs, inspecting them and their collected diffs, the job actions (publish, verify, merge under granted repository authority, cancel, review, correct, reconcile), the workspace snapshot, provider access and task listing, observations, and local-assistance requests and their outcomes. It acts only on jobs whose `botId` is that dog (corrections and reviews inherit it), reads jobs nobody owns without changing them, and never sees another dog's jobs or local-assistance results; the provider's own task list (`list_provider_tasks`, needed to reconcile an uncertain submission) is account-wide and not filtered. Repositories, verification checks, provider and GitHub logins, device pairing and revocation, and the Worker's `/admin/*` levers are refused with one sentence the dog can repeat; the person does those in the Workspace or with the `pnpm laterdog:*` commands.

Limits: dog tokens do not expire, and rotating the admin token is the only way to revoke them (all at once). The scoped token takes the admin token out of what every dog is handed; it does not sandbox a dog whose engine can run commands as your user, which can still read the admin token file in `~/.laterdog/`, and can call the desktop's own `/api/laterdog/*` proxy (which presents the admin token) wherever a loopback caller is trusted: reads in the packaged app, everything under `pnpm laterdog:dev`.

## Pair the Mac

In Workspace choose **Pair this computer**, specify exact absolute repository roots and optionally allow local-bot assistance. Save its single-use five-minute code to a private file, then run:

```sh
pnpm laterdog:bridge --url https://your-supervisor.example --pair-code-file /private/pairing-code --label 'My Mac'
```

Remove the now-used pairing file. The bridge stores its private device credential in `~/.laterdog/bridge/device.json`; the remote service stores a hash. With an already configured local assistance bot add `--bot-id BOT_ID --workspace-url http://127.0.0.1:LOCAL_WORKSPACE_PORT`. That local bot owns its normal CUA/browser permissions. A separate bridge remains usable while the desktop views a remote server, but does not start a local CUA harness by itself.

Metadata inspection reads Git status, branch, redacted remote URL and bounded package metadata; it does not read `.env`, provider keys, or raw Git credentials. Assistance requests carry a scoped root and instructions, not a copy of unrelated secrets. Symlinks escaping paired roots are refused. Offline requests are queued; claimed requests redeliver the same identity and local receipts avoid replaying uncertain task creation/sends. Revoke pairing through `DELETE /api/laterdog/bridge/devices/DEVICE_ID`.

## Paid backend qualification

Cloudflare compute stays disabled until account grant coverage and an explicit spending budget are documented. Qualify a scoped runner with external durable state, export diffs and evidence before sandbox sleep, and separately prove the desired subscription authentication. The API-key example is not that proof. Cursor and additional cloud providers need a complete submit → inspect → collect → PR → verify → correction round trip before being enabled. These integrations are not implemented by merely selecting a conversation model.
