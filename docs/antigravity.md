# Antigravity

Antigravity is a later.dog engine that uses your own Google AI plan. later.dog
runs Google's official [`agy` CLI](https://antigravity.google/docs/ide/extensions/acp/)
as an ACP server (`agy acp`) and talks to it over stdio, so sessions,
streaming, tools, permission requests, MCP integrations, resume and cancel work
the way they do on the other ACP engines.

Dogs on this engine use the plan of the Google account you sign in with, not a
separate API key.

What later.dog does with agy, and what it never does:

- It starts the official, unmodified `agy`, and only as `agy acp`.
- It never uses `agy -p`.
- It never proxies agy or its sign-in, and never calls Google with agy's
  credentials.
- It never reads agy's tokens. agy keeps its own sign-in, and later.dog asks agy
  whether it is signed in.
- It never starts agy with `--dangerously-skip-permissions`.

## Setup

1. Install agy. Google's installer puts it in `~/.local/bin`:

   ```sh
   curl -fsSL https://antigravity.google/cli/install.sh | bash   # macOS / Linux
   ```

   Google's script also adds `~/.local/bin` to your shell profile. later.dog
   looks for `agy` on `PATH` and in `~/.local/bin`, and the engine stays
   unavailable until it finds one. A Cloud home needs no install: its image
   already holds agy (see "The Cloud home" below).

2. Sign in from Settings › AI accounts › Add account › Antigravity, from the
   picker's Sign in when a dog is on a signed-out Antigravity, or from the Cloud's
   engine sign-in. The steps are the same on a Mac and on a Cloud home, on the
   desktop and on the phone:

   1. later.dog starts agy's own terminal sign-in (`agy acp --login`) and shows
      the Google link it prints.
   2. Open the link and sign in with your Google account. Google's page then
      shows a code.
   3. Paste the code, or the whole address of the page you land on, into
      later.dog. later.dog hands what you paste to agy exactly as it is.
   4. agy finishes the sign-in. later.dog checks with agy that it is signed in.

   If Google does not accept the code, later.dog shows what agy said and you can
   try again. Sign out from the account's row; later.dog asks agy to log out.

   These use the instance auth routes (`/api/instances/:id/auth/start`,
   `/auth/status`, `/auth/complete`, `/auth/cancel` and `/auth/sign-out`). The
   instance reports `paste-code` as its sign-in method.

3. Confirm `agy --version` prints a version. It is not listed in `agy --help`,
   but it works.

## One Google account

A home has one Antigravity account. Add account stops offering Antigravity once
there is one, and later.dog never switches between Google accounts or rotates
across several. It offers no second account.

## The account card

The account card shows one line: "Google limits automated use of personal
plans." It is a plain notice about Google's rules for your plan. later.dog adds
no limit of its own to this engine, and the card lists no others.

## Models and effort

Once you are signed in, agy lists its models and effort levels in the options
of a session, and later.dog shows them as agy gives them. Nothing is filtered,
and no model name is written into later.dog, so a model Google retires does not
stay in the picker. The last list is kept, so the picker has something to show
between sessions. Until you pick one, agy uses its own default. Before the first
sign-in the picker offers a single default entry.

## Approval levels

| later.dog level | agy mode |
| --- | --- |
| Ask for approval | `default` |
| Auto-accept edits | `accept-edits` |
| Full access | `auto`, and later.dog approves every permission request agy sends |

If a session does not offer `auto`, Full access runs it in `default`, and
later.dog still approves every request itself. later.dog sets no other agy mode.
There is no separate Auto level (the one that uses a reviewer): it behaves as
Ask on this engine. Full access is chosen in the packaged desktop app, like the
other engines. See [Approval levels](approval-levels.md).

## MCP servers

later.dog's own MCP servers run over stdio, which agy always accepts.

A custom MCP server you add with an HTTP address needs agy to run one worker
process per session, so later.dog starts `agy acp --process-per-session` for a
turn that carries one. A custom server that uses SSE is not carried.

## Where the sign-in lives

- **On a Mac:** in agy's own `~/.gemini` folder and the macOS Keychain, as when
  you use agy yourself. later.dog does not move, copy or read them, and an agy
  that is already signed in on that Mac works without a second sign-in.
- **On a Cloud home:** in a file in agy's own folder on the home's storage. A
  Cloud home has no keychain, so later.dog tells agy to keep its sign-in in a
  file there. The sign-in and the agy that runs your dogs use the same folder.

## The Cloud home

The Cloud home image holds one pinned agy at `/usr/local/bin/agy`, root's:

- `AGY_VERSION` names the release and its build (`1.5.17-4823843970351104`).
  `AGY_SHA512_X64` and `AGY_SHA512_ARM64` hold the SHA-512 of each architecture's
  download. The build fetches Google's versioned download for its architecture,
  refuses it if the SHA-512 differs, installs only the `antigravity` file from it
  and checks that `agy --version` prints the pinned version. An architecture
  other than x64 or arm64 fails the build. `--build-arg AGY_VERSION=` leaves agy
  out on purpose.
- The image never runs Google's install script. It cannot pin a version and it
  edits shell profiles.
- The image sets `AGY_CLI_DISABLE_AUTO_UPDATE=true`, so agy never replaces
  itself. A newer agy reaches a Cloud home only in a new image.

To move the pin, read the new release's `version`, `url` and `sha512` for each
architecture from Google's manifests
(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json`
and `.../linux_arm64.json`), then change `AGY_VERSION` and both checksums
together. Google files its arm64 download under `linux-arm`, not `linux-arm64`,
and the Dockerfile's arm64 path follows that.

## Not yet proven

- No real Google sign-in has been completed through later.dog yet. On the real
  agy 1.5.17 the handshake, the link and prompt that `agy acp --login` prints,
  agy's answer to a wrong code and its "Authentication required" answer when
  signed out were checked. The paste step from start to finish, the sign-in file
  on a Cloud home and the model and effort options of a signed-in session have
  not been checked against the real agy.
- The arm64 agy in the Cloud home image was downloaded and matched to its
  recorded SHA-512, but it was never run, because that needs an arm64 machine.

## Testing

Normal unit and ACP protocol tests use a scripted fake ACP agent
(`server/testing/fake-acp-cli.ts`) and need no Google account.
`scripts/docker-image.test.ts` checks the image's agy step: the pin, both
checksums, the single extracted file, the version check, the cleanup and the
updater setting. Do not print tokens or upload agy's logs from a live run.
