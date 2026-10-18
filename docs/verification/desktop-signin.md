# Desktop sign-in preserves the current workspace

The desktop signs in with an email and an 8-digit code. Authentication connects
the account; it does not select another workspace or copy dogs and conversations.
The active local or explicitly selected remote workspace stays open.

## Sign-in completion

The once-only account screen closes when authentication succeeds. It does not
wait for a Cloud machine to provision or become available. A completed screen
stays closed through later account refreshes. Skipping still records Not now;
successful completion does not invoke that skip action.

Settings, later.dog Cloud uses the same form. Account and machine status remain
in Settings. The native Server menu remains available for explicit connection
selection and recovery from a Cloud workspace opened by older builds. Existing
local and hosted data are separate until the ownership work below is completed;
labels are not removed to imply synchronization that does not exist.

## How the sign-in works

`electron/cloud-sign-in.mjs` talks to the accounts service the phone uses
(`https://accounts.later.dog`, Better Auth email OTP):

1. `POST https://accounts.later.dog/api/auth/email-otp/send-verification-otp` with `type: "sign-in"`.
2. `POST https://accounts.later.dog/api/auth/sign-in/email-otp`, which returns the short-lived account
   session in `set-auth-token`.
3. With that session, the existing device flow without a browser:
   `POST https://accounts.later.dog/api/cloud/desktop/authorize`, `POST https://accounts.later.dog/api/cloud/desktop/approve`
   (account session as bearer), `POST https://accounts.later.dog/api/cloud/desktop/token`. This is the
   device token the Mac already used for its plan, its home and computer
   lending, so no accounts-service change is needed.
4. `POST https://accounts.later.dog/api/auth/sign-out` ends the short-lived account session.

Every request includes the configured accounts-service origin in its `Origin`
header. Node fetch adds `Sec-Fetch-Mode: cors`; Better Auth requires a trusted
origin when fetch metadata is present. In 0.3.30 the missing header caused HTTP
403 before an email was sent. The 0.3.31 client supplies it without changing the
accounts service's origin or CSRF checks.

The sign-in button accepts an immediate click, shows `Sending code…` while the
request is pending, and permits a retry after its one-line error. It does not
use the onboarding buttons' initial click delay. The main-process request has
a 20-second timeout.

Regression coverage includes the real Better Auth handler receiving Node-style
fetch metadata, denied missing or untrusted origins, accepted trusted-origin
send and verify requests, and the desktop client completing its fixture flow
against an origin-enforcing accounts fixture.

`createCloudAccountClient().adopt()` stores the device credential (OS-encrypted
`cloud-account.bin`, as before), after which the unchanged state loop, lending and
pairing take over. The device flow is only started after the code was right, so a
wrong code never spends the 10-per-10-minutes authorize allowance.

## Workspace ownership after sign-in

Electron owns `environments.json.activeId`. Account state updates record the
once-only sign-in offer and refresh account UI, but do not navigate or start
backup copying. Repeated ready/provisioning/account-restoration events leave the
active selection unchanged.

Sign-out forgets the account's saved Cloud connection and clears its desktop
session. It returns to the local workspace only when that removed connection
was active; unrelated selected servers and local pages remain open.

Previously opened Cloud workspaces remain accessible. Choose Server → This
computer to return to local dogs without deleting either workspace. Explicit
connect and Copy controls remain deliberate actions. The copy engine is a
backup transfer, not synchronization; sign-in no longer invokes it.

When the open Cloud home (or any other saved workspace) does not load, the
window stays on it. It shows one line, "Couldn't reach your home · Try again",
and tries again by itself after 5 s, 15 s, 30 s, 1 min, 2 min, then every
5 min. Try again reconnects at once. The window never switches to this Mac's
own dogs because the home is down, and a failed first copy of the Mac's dogs
still opens the home while the copy is tried again in the background
(`electron/home-unreachable.mjs`, `electron/cloud-window.mjs`). Once a copy
has failed, the home is the person's to use: every later automatic copy to
that home, the home's own Try again, and a copy after a relaunch asks for an
empty home. The copy checks when it starts, checks again after packing and
uploading, and sends `requireEmpty` with the restore, so the home itself refuses
under its maintenance lock, after it flushes its chats and right before it swaps
workspaces, if it gained a dog, a room or a chat in the meantime
(`server/cloud-move-http.ts`). Any of these stops the copy with `not_empty`
("Your home already has dogs, so the dogs on this Mac stayed here."), releases
the Mac's paused dogs and ends the automatic retries. Only the Copy control in
this Mac's Settings can replace such a home (`electron/cloud-auto-move.mjs`
records the failed copy per account and home). A home on an older build ignores
`requireEmpty`; there only the client's second check guards it, which leaves the
time of one request.
From the Server menu, a person signed in to Cloud whose home can't be reached
also stays on the home with the line, instead of this Mac's Settings.

The ownership alternatives and staged unification are documented in
[workspace ownership](../laterdog/workspace-ownership.md).

## Claude and ChatGPT sign-ins move with your dogs

Once Cloud is on, the home owns every AI account; the Mac is a window onto the
home. The workspace backup still carries no sign-in (it leaves out `providers/`
and every login folder on purpose). Sign-ins travel on their own, one account at
a time, over the paired HTTPS connection to the home, and they **move once,
never copy, never come back**: Claude's and ChatGPT's refresh tokens rotate, so
one login used from two places knocks one of them out. Signing out of Cloud does
not move a login back to the Mac; the Mac keeps showing those accounts as on your
later.dog Cloud.

When it runs: after the desktop's move flow succeeds, `handAccountsToCloud({ homeOrigin,
session })` (`electron/cloud-ai-accounts.mjs`; `session` returns a pairing grant)
runs once per app run, and again on a later launch for an account whose dogs
moved before this build. It is skipped when the home already had dogs and the
Mac's dogs stayed (`kept-local`).

For each account (`electron/cloud-ai-accounts.mjs`):

1. The Mac's server lists what can move (the mac-accounts route in `server/laterdog/mac-accounts.ts`,
   desktop-only, `server/laterdog/mac-accounts.ts`): the default Claude login,
   each added Claude account (`claude-<uuid>`) and the ordinary Codex (ChatGPT)
   login, with where the CLI keeps each one. The Keychain item name follows
   Claude Code 2.1.293 exactly (`server/laterdog/claude-keychain.ts`):
   `Claude Code-credentials`, plus `-<first 8 hex of sha256(NFC CLAUDE_CONFIG_DIR)>`
   whenever the CLI runs with `CLAUDE_CONFIG_DIR` set, account `$USER`.
2. The Mac pauses the account first (`PUT …/<id>/hold`, refused while a dog is
   using it). A paused account is loaded as unavailable with the reason "This
   account is on your later.dog Cloud now…" (`ProviderRegistry` `held`), so this Mac's
   server never starts its CLI, a turn, a model refresh or a token refresh.
3. The Mac reads the login in memory only: the Keychain through
   `/usr/bin/security find-generic-password -a <account> -w -s <service>`
   (no shell; a macOS prompt is acceptable), else the CLI's plaintext
   `.credentials.json`, else Codex's `auth.json` (file storage only; a Codex
   login kept in the Keychain is left out).
4. It sends `PUT /api/laterdog/accounts/<id>` to the home
   (`server/laterdog/home-accounts.ts`), accepted only on a Cloud home and only
   from a bearer session with owner scope (the paired desktop; a browser cookie
   is refused). The home writes the login in the Linux form the CLI reads, into
   that account's own folder, `0700`/`0600`: `providers/<id>/.credentials.json`
   (`{"claudeAiOauth": …}`) with `configDir` set, or `providers/codex/auth.json`
   plus `cli_auth_credentials_store = "file"` with `CODEX_HOME` set. The account
   keeps the Mac's id and name, so the dogs' account choices still resolve. The
   home never writes into `/data/.claude` or `/data/.codex`, never replaces a
   sign-in it made itself (`409 home_signed_in`), and undoes the write when its
   CLI does not report the account signed in (`422`).
5. Only after the home answers `signedIn: true` does the Mac record the account
   as on My Cloud (`cloud-ai-accounts.json` in user data: ids, names, the home's
   origin and where it came from, plus a random per-install device id; no
   secrets) and keep it paused. The record is per home: accounts recorded for
   another home are never handed to this one and stay paused (`elsewhere`).
6. The Mac un-pauses an account only on the home's explicit refusal (`409` other
   than `busy`, `422`, `400`, `413`, `415`) or when there is no login to send.
   If the answer is lost, the home is unreachable or answers anything else, the
   account stays paused and the hand-over is retried (20 s, 1 min, 5 min, then
   every 15 min) until the home confirms it holds the login. Re-sending the same
   login is harmless: the home answers an identical login again without
   rewriting anything.
7. The home refuses (`409 other_device`) to replace a login that a different
   device (its device id travels in the hand-over) already handed over, unless
   the new login is for the same provider account (ChatGPT's `account_id`;
   Claude's login carries no account identity, so a different Claude login from
   another device is always refused). The Mac then keeps that account.

There is no way back: the home has no `/return`, `/keep` or delete route, the
Mac's Keychain is only ever read (`security find-generic-password`), never
written, and the Mac's own copy is left where it is.

Left out on purpose:

- ChatGPT plan accounts (`chatgpt`, `chatgpt-<uuid>`): later.dog's own OAuth
  record is bound to this Mac's host id and plan mode is refused on a Cloud home
  (`server/drivers/codex.ts`). They stay on the Mac and the quiet line names them.
- Claude API-key and company accounts, hand-edited instance ids, voice keys,
  connected apps and browser logins.

The quiet line says it in one sentence: "Your Claude and ChatGPT accounts are
here too." (or the Claude-only / ChatGPT-only form), and "Work Claude stayed on
this Mac for now." for any that did not come.

### Native limits kept visible

- The default Claude and Codex logins are the person's own terminal logins
  (`~/.claude` Keychain item, `~/.codex/auth.json`). later.dog stops using them,
  but a `claude` or `codex` run in a terminal on this Mac still can, and its
  token refresh can sign the home's copy out. The Mac's copy is not deleted, so
  the terminal keeps working until then.
- Proven only against fakes: the Keychain (a fake `security`), the CLIs (a fake
  "signed in" rule on the home), the home (the real route handlers on loopback
  HTTP). Not proven: a real Keychain read or prompt from the signed app, a real
  `claude auth status` on the Linux home reading only `.credentials.json`
  (read from the 2.1.293 binary, not run), a real Codex on the home, a real
  pairing, and how fast a real token refresh on one side signs out the other.

## Dev variant

`pnpm dev:desktop` runs source services and Vite with renderer hot reload. Its
workspace and native profile are isolated from the installed app. Main-process
changes require restarting the dev command.

Unpackaged Electron currently gates its real Cloud-account bridge to installed
builds. The isolated `desktop-signin` fixture exercises real account/sign-in
clients against fake accounts, while focused Node tests execute the actual
Electron observer and menu wiring. Starting the dev app alone does not prove a
real native email sign-in.

## Run it

```sh
node --test electron/cloud-sign-in.node-test.mjs electron/cloud-auto-move.node-test.mjs \
  electron/cloud-default-home.node-test.mjs electron/cloud-account.node-test.mjs \
  electron/cloud-account-ipc.node-test.mjs electron/cloud-move.node-test.mjs \
  electron/cloud-ai-accounts.node-test.mjs
pnpm exec vitest run src/components/CloudSignInGate.dom.test.ts \
  src/components/CloudQuietLine.dom.test.ts src/components/CloudAccountSettings.dom.test.ts \
  src/lib/cloud-sign-in-view.test.ts src/lib/cloud-move-line.test.ts \
  server/laterdog/claude-keychain.test.ts server/laterdog/mac-accounts.test.ts \
  server/laterdog/home-accounts.test.ts server/laterdog/account-handoff.e2e.test.ts \
  server/plan-usage.test.ts
```

`server/laterdog/account-handoff.e2e.test.ts` is the fixture proof for the sign-in move: the
real Mac and home route handlers on loopback HTTP, the real desktop engine, a
fake Keychain, fixture logins in temporary folders. It covers the happy path, a
partial failure and its retry, the Mac refusing to start a moved account, the
home keeping its own sign-in, moving back on sign-out (with the home's
refreshed token, and without overwriting a newer Mac login), and that no login
reaches logs, answers, summaries or records.

The screens are driven in the real renderer against the fake-engine fixture with
a scripted desktop bridge. The bridge runs the real `createCloudSignIn`,
`createCloudAccountClient` and once-only offer in Node against a fake accounts
service (`electron/fixtures/fake-accounts.mjs`). Launch it in one terminal, then
run the recipe in another, once per part (each part wants a fresh fixture; the
browser fixture's page occasionally sticks on its launch splash after about ten
reloads in one session):

```sh
node --experimental-strip-types scripts/control-laterdog.ts ui launch --entry desktop-signin
node --experimental-strip-types scripts/verify-desktop-signin.ts /tmp/laterdog-verify-data-XXXXXX/ui.json 1
node --experimental-strip-types scripts/verify-desktop-signin.ts /tmp/laterdog-verify-data-XXXXXX/ui.json 2
```

The updated recipe seeds a local fixture dog and conversation, completes sign-in,
and checks that the same page, bot IDs and messages remain. It explicitly opens
a Cloud connection only when exercising the manual recovery path. Historical
screenshots under `assets/desktop-signin` describe the older automatic-navigation
behavior and are not evidence for the current policy.

## Not proven here

- A real Electron window: the main-process wiring (`observeCloudHome`, the
  Server menu, window title, staying on an unreachable home, the IPC) is covered by node tests executing
  the observer and menu wiring plus the IPC guard, and the renderer by the browser fixture, but
  not by driving a packaged app.
- Real accounts: the real OTP email, a real home that wakes from sleep, the
  real pairing, and a real move of a real workspace (the move engine is tested
  against an in-memory home in `cloud-move.node-test.mjs`; the quiet line's move
  states in the browser fixture are scripted).
- The home page shows the quiet line and the Sign out row only once the home's
  container image carries this build.
