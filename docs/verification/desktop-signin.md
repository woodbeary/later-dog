# Desktop sign-in: one account, the same dogs on the Mac and the phone

The desktop app signs in the way the iPhone app does: an email, one "Agree and
continue", an 8-digit code. After that the window shows the person's home (My
Cloud, the later.dog server in a Cloudflare container that holds their dogs)
and nothing asks the person to connect anything.

## What a person sees

First launch, or an app already in use that has never been asked (one calm
screen, once):

1. The account screen: the dog, "later.dog", "Use your email. We'll send you a
   code.", an email field, **Agree and continue**, and the line "You accept the
   Terms and Privacy Policy, and that what you send your dogs goes to the AI that
   answers them, like Kimi on Cloudflare or Grok by xAI." Below it, quietly:
   "Use this Mac without an account".
2. Tap **Agree and continue** (the only tap). A code is emailed.
3. Type or paste the 8-digit code. It submits by itself on the eighth digit.
4. The window opens the home. Nothing else to confirm, no browser, no server
   picker, no pairing code. If the home is still being set up the same card says
   so on one line and opens the home by itself when it is ready.

"Use this Mac without an account" ends the screen for good and the app is exactly
what it is today (the local welcome flow on a first launch). The screen is never
offered again; Settings, later.dog Cloud has the same form. Signed out is the
free, open-source use and is unchanged.

A signed-in person has no Server menu, no server switcher in the sidebar (only
"My Cloud", not clickable) and a window titled just "later.dog".

## How the sign-in works

`electron/cloud-sign-in.mjs` talks to the accounts service the phone uses
(`https://accounts.later.dog`, Better Auth email OTP):

1. `POST /api/auth/email-otp/send-verification-otp` with `type: "sign-in"`.
2. `POST /api/auth/sign-in/email-otp`, which returns the short-lived account
   session in `set-auth-token`.
3. With that session, the existing device flow without a browser:
   `POST /api/cloud/desktop/authorize`, `POST /api/cloud/desktop/approve`
   (account session as bearer), `POST /api/cloud/desktop/token`. This is the
   device token the Mac already used for its plan, its home and computer
   lending, so no accounts-service change is needed.
4. `POST /api/auth/sign-out` ends the short-lived account session.

`createCloudAccountClient().adopt()` stores the device credential (OS-encrypted
`cloud-account.bin`, as before), after which the unchanged state loop, lending and
pairing take over. The device flow is only started after the code was right, so a
wrong code never spends the 10-per-10-minutes authorize allowance.

## After sign-in: the home is the window

`electron/cloud-default-home.mjs` holds the rules and `main.mjs` observes the
account state:

- connected and home ready, window not on the home, not already opened this run:
  open the home (the existing pairing and `connectCloudHome`). The home entry is
  made active and persisted, so later launches load the home directly.
- the home cannot be reached: the window shows this Mac's dogs, with the quiet
  line "Can't reach your home right now. Showing the dogs on this Mac. Try again".
  No dialog, and it does not loop.
- sign out (Settings on the home or on this Mac): the window returns to this Mac,
  the My Cloud entry is removed and the home session and its stored data in this
  app are cleared.
- the Mac still lends itself to the home on sign-in, as `computer-sharing.mjs`
  already does.

## Moving this Mac's dogs: automatic, once, never destructive

`electron/cloud-auto-move.mjs` drives `cloud-move.mjs` (which exports the
workspace as an encrypted backup, uploads it in verified parts, has the home
read it back, installs it and waits for the home to restart):

- It runs in the background after the home is ready. Nothing is a modal. The
  window shows one quiet line along the bottom: "Moving your dogs here from this
  Mac… 42%", "Almost there. Your home restarts to open them.", then "Your dogs
  from this Mac are here now. This Mac keeps its copy.".
- **The local copy is never touched.** The move only reads this Mac's workspace
  (export, download). Nothing is deleted or rewritten here, before, during or
  after, so there is no state in which a dog exists only on the wire.
- **The home must be empty.** The move is started with `requireEmpty`. A home
  that already has dogs (for example from the phone) is never replaced
  automatically: the Mac's dogs stay, the line says "Your home already has dogs,
  so the dogs on this Mac stayed here.", and the choice is remembered. The
  explicit Copy in Settings (which warns, replaces and keeps an undo copy) is
  still there.
- **Arrival is proven.** After the home installs the workspace the move compares
  the home's bot, room and chat counts with what this Mac sent
  (`verifyArrival`). A home with fewer of any is a failure, not a success, and is
  not recorded as moved.
- **Once.** The result is remembered per account in `cloud-auto-move.json` (also
  "nothing worth moving": a Mac with only its starter dog and no chats). Offered
  again only after a failure.
- **If it cannot finish** the dogs simply stay on this Mac and the line says so
  in one sentence with Try again: "Your dogs are still on this Mac. They couldn't
  move yet.". Failures that can pass (busy bots, a dropped connection, a busy
  home) retry by themselves after 20 s, 1 min, 5 min and 15 min, then wait for
  the person. A failure that cannot pass by waiting (too large) is not retried.
- Limits it keeps from `cloud-move.mjs`: 10 GB (`CLOUD_MOVE_MAX_BYTES`), the
  plan's disk (it asks the home to grow the volume when the plan allows), no
  merge (the home must be empty), and the home restarts to install the copy.

## Claude and ChatGPT sign-ins stay where they are

Nothing here copies, moves or syncs an AI account. The later.dog account
(email and code) is separate from Claude and ChatGPT. The move is the existing
workspace backup, which excludes saved credentials, provider and MCP
connections, managed provider login homes and browser login profiles
(`server/workspace-backup.ts`, `server/workspace-backup-policy.ts`); the Mac's
Claude Keychain entry and ChatGPT login folder are never read, and ChatGPT's
rotating refresh token is never held in two places. Where the person signs in
to Claude or ChatGPT a second time:

- On the home: the dogs that moved arrive without any AI sign-in, so the home
  shows its existing "Sign in to Claude or ChatGPT" step (`CloudEngineSignIn`,
  the first item of "Set up My Cloud") once, until the person signs in there.
  Until then the home's dogs use the free included AI.
- Back on this Mac (signed out, or the home cannot be reached): nothing,
  this Mac's own sign-ins are untouched.
- Voice keys, connected apps and browser logins made on the Mac do not reach the
  home either; each is set up again on the home when wanted.

The design needs no AI sign-in on the home to work, so nothing was built for it;
where the AI accounts should live once Cloud is on is left open.

## Dev variant

`LATERDOG_APP_VARIANT=dev` changes nothing here. The account credential, the
once-only offer (`cloud-offer.json`) and the move record (`cloud-auto-move.json`)
live in the variant's own user-data folder, so later.dog Dev asks once for itself,
and its local dogs are moved only into an empty home. Signing in with the real
email from Dev signs Dev in to the same account and home as the phone.

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

Screenshots are in [assets/desktop-signin](assets/desktop-signin).

| Step | Screenshot |
|---|---|
| First launch: the account screen | `01-first-launch-email.png` |
| The code | `02-code.png` |
| After the code: the window is the home | `03-home-after-sign-in.png` |
| Quiet line: moving, finishing, done | `04`, `05`, `06` |
| Quiet line: could not move (Try again), home already has dogs | `07`, `08` |
| An app already in use: the same screen, once | `10-existing-user-one-screen.png` |
| Not now: exactly as today | `11-existing-user-declined-as-today.png` |
| Not now on first launch: today's welcome flow | `12-declined-first-launch-continues-locally.png` |
| A wrong code, an email outage | `13`, `14` |
| A home still being set up | `15-home-being-set-up.png` |
| The home cannot be reached | `16-home-unreachable-quiet-line.png` |

## Not proven here

- A real Electron window: the main-process wiring (`observeCloudHome`, the
  Server menu, window title, the fall-back, the IPC) is covered by node tests of
  the pure rules and the IPC guard, and the renderer by the browser fixture, but
  not by driving a packaged app.
- Real accounts: the real OTP email, a real home that wakes from sleep, the
  real pairing, and a real move of a real workspace (the move engine is tested
  against an in-memory home in `cloud-move.node-test.mjs`; the quiet line's move
  states in the browser fixture are scripted).
- The home page shows the quiet line and the Sign out row only once the home's
  container image carries this build.
