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

The ownership alternatives and staged unification are documented in
[workspace ownership](../laterdog/workspace-ownership.md).

## Claude and ChatGPT sign-ins stay where they are

Nothing here copies, moves or syncs an AI account. The later.dog account
(email and code) is separate from Claude and ChatGPT. An explicit copy uses the
existing workspace backup, which excludes saved credentials, provider and MCP
connections, managed provider login homes and browser login profiles
(`server/workspace-backup.ts`, `server/workspace-backup-policy.ts`); the Mac's
Claude Keychain entry and ChatGPT login folder are never read, and ChatGPT's
rotating refresh token is never held in two places. When you deliberately copy
dogs into a hosted workspace, its AI connections need separate sign-ins:

- On the home: copied dogs arrive without any AI sign-in, so the home
  shows its existing "Sign in to Claude or ChatGPT" step (`CloudEngineSignIn`,
  the first item of "Set up My Cloud") once, until you sign in there.
  Until then the home's dogs use the free included AI.
- This Mac's own sign-ins are untouched.
- Voice keys, connected apps and browser logins made on the Mac do not reach the
  home either; each is set up again on the home when wanted.

The design needs no AI sign-in on the home to work, so nothing was built for it;
where the AI accounts should live once Cloud is on is left open.

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
  electron/cloud-account-ipc.node-test.mjs electron/cloud-move.node-test.mjs
pnpm exec vitest run src/components/CloudSignInGate.dom.test.ts \
  src/components/CloudQuietLine.dom.test.ts src/components/CloudAccountSettings.dom.test.ts \
  src/lib/cloud-sign-in-view.test.ts src/lib/cloud-move-line.test.ts
```

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
  Server menu, window title, the fall-back, the IPC) is covered by node tests executing
  the observer and menu wiring plus the IPC guard, and the renderer by the browser fixture, but
  not by driving a packaged app.
- Real accounts: the real OTP email, a real home that wakes from sleep, the
  real pairing, and a real move of a real workspace (the move engine is tested
  against an in-memory home in `cloud-move.node-test.mjs`; the quiet line's move
  states in the browser fixture are scripted).
- The home page shows the quiet line and the Sign out row only once the home's
  container image carries this build.
