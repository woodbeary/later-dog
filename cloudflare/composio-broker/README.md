# later.dog connected-apps broker

This Worker keeps the shared Composio project key out of desktop builds. Each
installation receives a random bearer token stored only as a SHA-256 hash in
D1. The Worker gives that installation its own Composio user/session, proxies
MCP traffic, and returns short-lived Connect Links to the local app.

The desktop never receives the project key. Authorization links are returned
only on demand and are never persisted in chat messages.

Deployment for this repository:

1. `bun run broker:types`
2. `bun run wrangler d1 migrations apply laterdog-composio --remote --config cloudflare/composio-broker/wrangler.jsonc`
3. For an existing Worker, run `bun run wrangler secret put COMPOSIO_API_KEY --config cloudflare/composio-broker/wrangler.jsonc`, then `bun run broker:deploy`.
4. For the very first deploy, put `COMPOSIO_API_KEY=...` in the ignored `.dev.vars.production` file and run `bun run wrangler deploy --config cloudflare/composio-broker/wrangler.jsonc --secrets-file .dev.vars.production`. Delete the file immediately afterward.

Forks should create their own D1 database and rate-limit namespaces, replace
the IDs in `wrangler.jsonc`, deploy under their own Worker name, and set
`LATERDOG_COMPOSIO_BROKER_URL` in their packaged build. Running only the local
server with a Composio project key remains the no-Cloudflare self-host path.

Set `REGISTRATION_MODE` to `closed` to stop issuing new installation tokens
without affecting existing users.
