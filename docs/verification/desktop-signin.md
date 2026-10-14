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

## Claude and ChatGPT sign-ins move with your dogs

Once Cloud is on, the home owns every AI account; the Mac is a window onto the
home and a computer the dogs can use. The workspace backup still carries no
sign-in (it leaves out `providers/` and every login folder on purpose). Sign-ins
travel on their own, one account at a time, over the paired HTTPS connection to
the home, and they **move, never copy**: Claude's and ChatGPT's refresh tokens
rotate, so one login used from two places knocks one of them out.

When it runs: after the automatic move is final for this later.dog account
(`moved`, or `nothing` worth moving), once per app run, and also on a later
launch for an account whose dogs moved before this build. It is skipped when the
home already had dogs and the Mac's dogs stayed (`kept-local`).

For each account (`electron/cloud-ai-accounts.mjs`):

1. The Mac's server lists what can move (`GET /api/laterdog/mac-accounts`,
   desktop-only, `server/laterdog/mac-accounts.ts`): the default Claude login,
   each added Claude account (`claude-<uuid>`) and the ordinary Codex (ChatGPT)
   login, with where the CLI keeps each one. The Keychain item name follows
   Claude Code 2.1.293 exactly (`server/laterdog/claude-keychain.ts`):
   `Claude Code-credentials`, plus `-<first 8 hex of sha256(NFC CLAUDE_CONFIG_DIR)>`
   whenever the CLI runs with `CLAUDE_CONFIG_DIR` set, account `$USER`.
2. The Mac pauses the account first (`PUT …/<id>/hold`, refused while a dog is
   using it). A paused account is loaded as unavailable with the reason "This
   account is on My Cloud now…" (`ProviderRegistry` `held`), so this Mac's
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
   as on My Cloud (`cloud-ai-accounts.json` in user data: ids, names and where
   it came from, no secrets) and keep it paused. Anything else un-pauses it, the
   quiet line names it, and it retries after 20 s, 1 min, 5 min and 15 min.

Signing out of later.dog Cloud on the Mac first brings each account back
(`POST …/<id>/return`: the home pauses it and hands over the login as it last
refreshed it; the Mac writes it where it came from, the Keychain through
`security -i` on stdin exactly as Claude Code does, keeping the item's other
keys; then `DELETE …/<id>` and the home forgets it). If the Mac signed in again
to that account while it was away, the newer Mac login is kept. An account that
cannot come back (home unreachable) stays on My Cloud and stays paused here.

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
  token refresh can sign the home's copy out (or the reverse). The Mac's copy is
  not deleted, so the terminal keeps working.
- Proven only against fakes: the Keychain (a fake `security`), the CLIs (a fake
  "signed in" rule on the home), the home (the real route handlers on loopback
  HTTP). Not proven: a real Keychain read or prompt from the signed app, a real
  `claude auth status` on the Linux home reading only `.credentials.json`
  (read from the 2.1.293 binary, not run), a real Codex on the home, a real
  pairing, and how fast a real token refresh on one side signs out the other.

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
  electron/cloud-account-ipc.node-test.mjs electron/cloud-move.node-test.mjs \
  electron/cloud-ai-accounts.node-test.mjs
pnpm exec vitest run src/components/CloudSignInGate.dom.test.ts \
  src/components/CloudQuietLine.dom.test.ts src/components/CloudAccountSettings.dom.test.ts \
  src/lib/cloud-sign-in-view.test.ts src/lib/cloud-move-line.test.ts \
  server/laterdog/claude-keychain.test.ts server/laterdog/mac-accounts.test.ts \
  server/laterdog/home-accounts.test.ts server/laterdog/account-handoff.e2e.test.ts \
  server/plan-usage.test.ts
```

`account-handoff.e2e.test.ts` is the fixture proof for the sign-in move: the
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
