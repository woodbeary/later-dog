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

## later.dog's shared Google connection (item 33, 2026-11-14)

A Cloud home with no client of its own now connects through later.dog's one
Google client; the setup steps and release order are in
[google-setup.md](../laterdog/google-setup.md).

- Accounts Worker: `GET /google-oauth/callback` passes `state`, `code` and
  `error` on to `https://<h + 24 hex><CLOUD_HOME_HOST_SUFFIX>/google-oauth/callback`
  and nowhere else; `AccountsApi.googleClient()` and `googleToken()` hold the
  only copy of the secret, add the fixed redirect address, cap each account at
  500 calls a day, and log only a fixed message and an error code.
- Worker in front of homes: `google.internal` answers `GET /client` and
  `POST /token` for the home's own account only, behind a per-home key that a
  home made before this change also gets, once.
- Home server: the owner's own client still wins. Otherwise a Cloud home uses
  the shared client: `state` starts with its machine ID, codes and refreshes go
  through `google.internal`, and the account record keeps the `clientId` that
  issued it. The home never sends, holds or logs a client secret on that path.

Checked on the Linux cloud computer against fixtures and a fake Google, never a
real Google account or a real home: `cloudflare/control-plane` 152 of 152 tests
(13 new), `deploy/laterdog/home` 332 of 332 (12 new), and in `server/` the
Google route, protocol, shared-connection and Cloud home tests plus a real home
server started as a Cloud home whose dog connects, gets called back, and reads
Gmail through a fake `google.internal` (26 Google tests, 1 end-to-end). Each new
test was also run against a deliberately broken copy of the code it protects and
failed there.

Not proven: no real Google client exists yet, so no real consent, code exchange
or refresh has run; no real accounts Worker, Worker in front of homes or home
has run this code; the approval reaching a home that is asleep is unchanged and
unproven (the dog's turn normally keeps it awake for the 15 minutes the approval
is valid).

Condition before later.dog asks Google to verify the app: the approval must
return to the device that started it, or the owner must confirm on a page that
names whose later.dog is being connected. Until then a person with a home of
their own could send someone else an approval link and, if that person approved,
read their Gmail; while the app is unverified Google warns about it on its own
page, so this gives nobody more than a client of their own would.
