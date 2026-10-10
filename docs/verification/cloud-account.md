# Optional personal later.dog Cloud account

> **Not offered by later.dog.** This page documents code that later.dog carries but does not run as a service: there is no later.dog Cloud, hosted account service, phone app or paid plan. It stays until that code is removed or replaced; see [docs/laterdog/roadmap.md](../laterdog/roadmap.md).

Personal Cloud is independent of the organization connection, the hosted
Companion account, local profile fields, providers, bots and chat history.
Fresh startup without a saved Cloud credential makes no Cloud request and
opens no browser. Cloud authentication is optional; its failure never blocks
free local use. The desktop app no longer has a Cloud account page: nothing in
it signs in to or out of Cloud. It only reads the saved session's plan, opens
the dashboard and connects to My Cloud.

## Contract and boundaries

The installed desktop uses only `https://cloud.later.dog`. The renderer
cannot supply an origin, callback URL, account credential, checkout URL or Pro
flag. Explicitly injected HTTP loopback is available only to isolated fixtures.
These endpoints belong to the remote Cloud service, not the local app server.

- `POST https://cloud.later.dog/api/cloud/desktop/authorize` accepts
  `deviceName`, `platform` and optional `appVersion`. It returns `cloudContractVersion: 1`, a private
  `deviceCode`, a display `userCode`, `expiresIn` (at most 600 seconds),
  `interval` (5–60 seconds), and the exact same-origin browser destination
  `/cloud/desktop?code=<userCode>`.
- The browser completes email-code authentication and explicit device approval.
  Electron polls `POST https://cloud.later.dog/api/cloud/desktop/token`
  with the private device code.
  A successful response has `cloudContractVersion: 1`, `accessToken` (`omc_`
  plus 43 base64url characters), `expiresAt`, `device: {id}` and
  `account: {id,email}`. Pending/slow-down/denied/expired replies follow the
  existing device-authorization error convention.
- Electron persists only the credential and identity in a separate OS-encrypted
  `cloud-account.bin`. It never persists Pro, writes the local workspace config,
  or sends this token to renderer JavaScript, organization services or engines.
- `GET https://cloud.later.dog/api/cloud/desktop/session` with the bearer
  returns the same identity,
  contract version and expiry, plus
  `entitlement: {plan: "free" | "pro", tier?: string, status: "active" | "inactive",
  expiresAt: number | null, version: number}`. Timestamps are integer Unix
  milliseconds. Identity mismatch/401/403 requires reauthentication; other
  failures remove verified entitlement until a successful retry.
  Active Pro requires a non-null future expiry; a free/active combination or
  already-expired active entitlement is refused as an invalid response.
- `plan: "pro"` means any paid plan; the optional `tier` names it
  (`personal`, `pro`, `max`, or a later one). A tier is a short lowercase
  token (`/^[a-z][a-z0-9-]{0,23}$/`); a missing or malformed one is simply no
  tier and never rejects or downgrades a paid entitlement. A plan string newer
  than the app (for example `"max"`) is read as paid with that tier and
  logged once, instead of failing the whole session.
- Only this verified session counts as Pro. Verification lasts at most one
  minute and never past credential or active-entitlement expiry; it is never
  restored from disk. The browser dashboard is the fixed `/cloud` URL. Opening
  it does not activate Pro.
- Sign-out independently deletes the local credential and requests
  `DELETE https://cloud.later.dog/api/cloud/desktop/session`. A failed
  remote revocation is disclosed; failure to clear the durable record blocks
  a new sign-in until cleanup works.
  Sign-out does not cancel the subscription or disconnect the organization.

There is no credential-bearing deep link and no checkout-result callback.
Device polling completes browser approval automatically. The existing
`laterdog://organization` action is unchanged.

## Automated fixtures

```sh
node --test electron/cloud-account.node-test.mjs electron/cloud-account-ipc.node-test.mjs electron/organization-reopen.node-test.mjs
pnpm exec tsc --noEmit
pnpm check:electron
pnpm i18n:check
```

Client tests launch their own loopback HTTP server. They cover optional startup,
private polling, strict URLs, stale/cancelled responses, failed persistence,
revocation, network/malformed session failure, expiry, and explicit sign-out.
Storage tests use a temporary file and substitute encryption; they do not touch
the user's keychain. Production preload/main IPC tests reject remote and child
frames and verify renderer arguments cannot cross the account boundary.

This is not production qualification: approval and entitlements are
synthetic. Real OTP, billing-webhook activation, keychain persistence and a
shipped desktop build need separate qualification. Server-side enforcement of
paid service requests must remain authoritative; the desktop's plan check is
not an access-control gate.
