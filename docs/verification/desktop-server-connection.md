# Desktop server connection

The desktop app switches between this computer and saved servers from two
native menus: the server switcher at the top of the sidebar
(`src/components/DesktopWorkspaceSwitcher.tsx`, which opens the native
workspace menu) and the application's **Server** menu. Settings has no
Servers page; the renderer smoke that mounted it was removed with it.

```sh
node --test electron/environments.node-test.mjs
pnpm exec vitest run electron/menu.test.mjs src/components/DesktopWorkspaceSwitcher.test.ts
```

The node tests check the pairing-link parser (a code stays in the URL
fragment; one anywhere else is refused), the saved list (adding a server twice
updates its name; forgetting the active one falls back to this computer), that
only the active server's own main frame gets its identity, that renderer links
and redirects cannot switch servers, and that the workspace menu uses saved
IDs. The menu test checks that the **Server** menu adds a server only from a
copied pairing link; the switcher test checks its labels. These are unit
checks. They do not prove public DNS/TLS, an authenticated connection to a
customer's server, or a physical click in the operating system's popup.

## User flow

In the desktop app, copy the server's HTTPS address or full pairing link, then
choose **Add Server from Copied Pairing Link…** from the server switcher at
the top of the sidebar or from the **Server** menu. Confirm the host in the
native dialog, then complete pairing or email sign-in on that server. To
generate an owner link without the CLI's phone wizard, run
`npx laterdog pair --label "My desktop"` on the server. Treat this link as a
secret. Existing limited-access links retain their limits.

Select **This computer** or a saved hosted workspace to switch. Each origin
keeps its own session, bots, chats, provider credentials and settings. **Forget**
signs this desktop out and removes its saved connection, not the server's bots
or data. The server must remain running independently.

The switcher renders in the server's own UI, so both desktop and hosted UI
need the update for the in-page control. When connecting to an older hosted
version, the native **Server** menu remains available to switch back to this
computer. Remote pages cannot enumerate the desktop's saved connections or
directly invoke switching, forgetting, or host-only controls.

## Optional computer sharing

**Computer sharing is disabled by default.** The exception is lending a Mac
to the person's own later.dog Cloud home, which has its own gate (see
`docs/cloud-pro.md`, "Let my Cloud use this Mac"); the desktop app no longer
has a switch for it.
Connecting and switching hosted workspaces still works, but does not offer
local file, terminal, or screen access. The flow below is maintainer-only
verification with `features.sharedComputers: true` on both servers, not a
recommended production setup or a Settings switch.

After pairing or signing in successfully, a native **Share this computer?**
dialog offers **Choose access** or **Not now** (the default). This choice is
remembered for that workspace identity and paired session, not repeated on
every switch. A different sign-in or server identity requires a new review.
Older servers need updating before they advertise this capability.

**Choose access** opens Settings → Computer, which has no sharing controls
now, so nothing in the app grants or changes access. Grants saved before keep
working, within these limits:

- Pick specific folders. They start read-only; **Allow edits** permits create
  and hash-guarded overwrite, not delete. Paths stay inside the chosen folder;
  symbolic/hard links and the desktop's own credential/profile storage are
  refused. Files are limited to 256 KiB per operation. This is a file-transfer
  interface, not a mounted filesystem or a sandbox for hostile local processes.
- **Unrestricted terminal** is a separate, broad opt-in: commands run as the
  desktop user and can read/write/delete outside those folders, including
  credentials. No inherited API-key environment or shell startup files; that
  does **not** confine commands. Maximum 30 seconds and 256 KiB output per call.
- **Computer control** is a separate broad opt-in: the official local Cua MCP
  can observe and operate logged-in apps, outside shared-folder boundaries.
  Local control and OS permissions must already be enabled. A local resource
  lease prevents concurrent calls with local bot turns and honours human holds.
  Between calls, another actor can change the screen: observe again before acting.

Saving requires a native confirmation naming the exact HTTPS workspace and
permissions. Shared content may reach that server's model provider. Nothing is
granted merely by connecting the workspace.

**Whose bots can use it.** A lent computer belongs to the person whose paired
session registered it. On that server, only a conversation that person started
(their own message, from a signed-in or paired session, started the turn) can
list or use it; continuations of that same request keep it. Another person's
conversation, a routine, a webhook, a room, a bot's delegated or peer turn and
the machine's own owner at loopback see no computers, and a known computer id
answers exactly like an unknown one. Entries are keyed by the registering
session, so no other session can take over or squat an id. The server also
refuses any operation outside the scopes the desktop registered, before
queuing it; the desktop still checks every operation against its own grant.
A bot whose **Computer** setting is off cannot use lent apps and screen.

**What folder access never reaches.** Besides the desktop's own data and grant
store, no folder operation (read, list or write) reaches the person's keys and
sign-in stores or places that run code by themselves, however the folder
around them was chosen: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`,
`~/.docker`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`,
`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.config/{gh,gcloud,op,git,fish,
autostart,systemd}`, browser profiles, `~/Library/{Keychains,Cookies,
LaunchAgents,Safari}` and `~/.local/bin` (the list is
`PERSONAL_SECRETS` in `electron/shared-computer-access.mjs`). A listing shows
them as `protected`. Writes are refused inside any `.git` directory, because
git runs commands from its configuration and hooks. Other files that programs
later run (scripts, build files) can still be edited in a writable folder.

**Computer control** offers only on-screen tools and, for each, only the
arguments that observe or operate the screen (`LENT_SCREEN_ARGUMENTS` in
`electron/lent-screen-tools.mjs`, derived from the driver's own schemas and
checked against a snapshot of them in `electron/fixtures`). The local driver's
other tools (uploading a local file into a page by path, recording or
replaying to a path, changing or updating its configuration, installing a
binary, opening a DevTools port, killing a process, raising permission
prompts) are refused and hidden, and so is every argument that names a file
(`screenshot_out_file`, `debug_image_out`, `image_path`, a path as a cursor
icon or as a URL to open), a command line or a port. Unknown arguments are
refused, never forwarded.

**Activity log.** The desktop records every request it receives (time, server,
action, folder name and relative path, tool name or command text, and whether
it ran or was refused) in `lending-activity.jsonl` next to the grants, owner
only. It only ever appends (never through a link); a full file of 500 entries
is moved aside intact as `lending-activity.jsonl.1`. It never records file
contents, output or typed text.

The connector runs in Electron main, outbound to the paired server; there is
no exposed local listener. Every request needs the live paired session plus a
separate connector secret. The desktop—not the server—checks each operation
against local grants. Grants are local, owner-only files and contain no pairing
code. File grants cannot expose Electron profile storage, including these grants.

Agents use `list_shared_computers` then `shared_computer`. They receive folder
IDs/names, not local absolute paths. A bot's turn capability must still be live
when a request is delivered and while it runs. Offline or uncertain operations
are never automatically replayed, and never fall back to the server filesystem.
Server restart clears the in-memory queue; the desktop reconnects without
replaying actions. Polls do not hold the workspace-backup maintenance gate.

Access persists across workspace switches while the desktop is open.
**Forget**, revoked pairing, or closing the desktop stops the connector. Running commands are cancelled where possible; a native action
already admitted by Cua may have completed. Inspect uncertain outcomes before
retrying. A sleeping/offline laptop cannot service requests.

The local feature flag is rechecked before reconnecting a saved grant,
accepting consent, dispatching a remote job, and on the existing one-second
job lease. A disabled or unreachable local server aborts the connector;
an in-flight check may take up to its three-second request deadline. Restart
the desktop after re-enabling the flag. Turning it off does not erase grants,
and a native operation already admitted may have completed.

## Connector and authority tests

```sh
pnpm exec vitest run server/shared-computers.test.ts server/shared-computers.e2e.test.ts server/shared-computers.gate.test.ts
node --test electron/shared-computer-access.node-test.mjs electron/lending-guards.node-test.mjs
```

The **Shared terminal smoke** workflow runs the native terminal tests and this
real-connector test on Windows. It covers ordinary cmdlets, quoted and Unicode
command text, leading declarations, pipelines, return/exit status and process
revocation. Windows PowerShell prioritizes its own modules while retaining the
rest of its resolved module search path. No new command restrictions or approval
prompts are introduced; the existing grants, timeout and cancellation remain.

The end-to-end test starts a **real isolated server**, pairs a desktop, opens
a fake-model turn, and launches the **real agents MCP process** with that
turn's capability. It reads/edits fixture files and runs a harmless terminal
command through the real outbound connector. It checks read-only denial,
traversal denial, per-session/secret ownership, cookie CSRF, local-control gate
rejection for remote sessions, in-flight revocation and durable access-off.
It writes a redacted receipt beside the fixture server log.

Unit tests cover turn cancellation, offline sessions, one-job delivery/no
replay, host-screen resource leases and human takeover, path/link/size limits,
protected desktop storage, terminal cancellation, and the persistent official-
style Cua MCP handshake/image transport using a stand-in. They do not operate
the user's screen or prove real Cua actions on each supported OS. No live VPS,
public HTTPS, Windows desktop, or macOS screen permission was exercised by this
recipe. Run those release smoke checks separately before claiming coverage.
