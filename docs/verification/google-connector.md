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
real Google account or a real home: `cloudflare/control-plane` 156 of 156 tests
(17 new), `deploy/laterdog/home` 333 of 333 (13 new), and in `server/` the
Google route, protocol, shared-connection and Cloud home tests plus a real home
server started as a Cloud home whose dog connects, gets called back, and reads
Gmail through a fake `google.internal` (27 Google tests, 1 end-to-end). Then 19
deliberate breakages, one at a time, of what these tests protect (the callback
going to any other host, the secret left out or the Worker on without it,
`invalid_grant`, the cap, a fifth token field, the token request in the log, the
caller choosing the account, a throw, no size limit, the route or an older home's
key not kept once, the shared client beating the owner's own, `state` without the
machine ID, a secret on the shared path, the record without `clientId`, a refresh
through the wrong client, the switched-off message): each one made a test fail.

Not proven: no real Google client exists yet, so no real consent, code exchange
or refresh has run; no real accounts Worker, Worker in front of homes or home
has run this code; the approval reaching a home that is asleep is unchanged and
unproven (the dog's turn normally keeps it awake for the 15 minutes the approval
is valid).

Review answers (2026-11-15, after Truth's review at `9266d85`):

- A refresh is refused unless that refresh token was given to the same account.
  The accounts Worker keeps a SHA-256 hash of each refresh token with its
  account (`0014`), written at the code exchange, checked on every refresh,
  removed when Google says the token is gone or the account is deleted. Before
  the fix, account B refreshing account A's token got an access token; now it
  gets `409` "later.dog can't confirm this Google connection belongs to this
  home. Connect again." and Google is not asked. A home then sees
  `gmail_search`, `gmail_read` and `gmail_code_to_vault` fail with those words,
  after the account's email, and its dog can call `connect_google` again.
- A test now fails if the home takes an approval address from the Worker that
  is not `https:` and exactly `/google-oauth/callback`.
- The Worker in front of homes remembers which key its Google route was
  registered with, as a hash, and registers again when the home's key differs,
  so a first setup cut off between the route and the record no longer leaves a
  route that refuses every call.

Conditions before the connection is switched on for anyone but Jacob, both
written out in [google-setup.md](../laterdog/google-setup.md):

- Google's published rules cap an unverified app that reads Gmail at 100 users
  in total. With one client, every home shares that cap, and anyone can use it
  up with throwaway Google accounts. Not checked against Google here.
- An approval link sent to someone else connects their Gmail to the sender's
  home, as built: the sender's dogs can read it and collect emailed sign-in
  codes. Before the connection is open to others, the approval must return to
  the device that started it, or the owner must confirm on a page that names
  whose later.dog is being connected.
