# Google connector

Native home OAuth code flow with PKCE, a one-use 15-minute state and an external
Google consent card. Requests openid, email and gmail.readonly. A requested email
must match the approved account. Each refresh token is encrypted using the owner
vault, stored separately under a hashed account name. Reserved Google vault names
cannot be injected into command tools or overwritten through capture/generation.
Saved secret IDs cannot be typed through vault_login. Provider error bodies are
not included in callbacks or tool results.

Tools: connect_google, gmail_search, gmail_read, gmail_code_to_vault. The last
extracts a numeric email code directly into a named vault item without returning
its value. Multiple accounts require explicit email selection.

Existing integration reviewed: server/composio.ts and cloudflare/composio-broker.
The broker D1 stores installation identity, hashed installation tokens and session
IDs; Composio owns upstream provider tokens. It cannot meet the requirement that
Google refresh tokens remain in the owner's home vault. No broker or D1 changes
are needed. Live Cloudflare inspection was attempted but the mounted connection
requires reauthentication; actual D1 contents remain unverified.

Google setup requires a Web application OAuth client, Gmail API enabled and the
exact public home URL plus /google-oauth/callback registered as redirect URI.
The home reads a saved googleapis.com login whose username is the client ID and
password is its client secret. No secret is returned through the dog tools.
Official protocol reference: https://developers.google.com/identity/protocols/oauth2/web-server

Pending live qualification: configure the OAuth client securely, activate the
server bundle, approve lopez731@gmail.com on Jacob's own phone/Mac and observe the
callback plus a real Gmail read. Fixture success does not establish inbox access.
Consent state is in memory; a home restart requires a fresh connection card.

Cloud verification: 100 checks across seven files passed in the fresh isolated
/tmp/hound-google-check-lRrMIc checkout (run 18e55769): Google protocol/routes,
vault encryption/references/password input, tool catalog and no-comments. An
earlier copied worktree could not run git ls-files because its .git pointer
referred to the home; the fresh checkout fixed the test harness. No Mac access,
Xcode or CI was used. Fable commit f39353f remains in the branch ancestry.

The complete pnpm typecheck passed on that isolated checkout. pnpm lint passed
with zero warnings/errors and pnpm i18n:check passed (run 6323aaf2). The superseded
pre-rebase typecheck was explicitly stopped; the result above is from current main
plus this connector change.

The isolated real home-server HTTP test passed: the public Google callback
responds without a later.dog session, rejects an unissued state, and the
capability-authenticated Google account listing works. Only this targeted index
test ran (280 unrelated index tests skipped); total focused checks passed: 101.
