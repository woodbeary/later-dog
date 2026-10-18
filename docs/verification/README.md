# Verifying later.dog

later.dog has one development control surface: `pnpm control:laterdog`. It is a
thin command-line adapter over `scripts/mcp-server.ts`, so verification uses
the same URL validation, task pinning, bounded transcripts, wait states, and
redaction as external MCP clients.

## Launch

Start a fixture in one terminal:

```sh
node --experimental-strip-types scripts/control-laterdog.ts launch
```

Run the foreground launcher directly rather than through `pnpm`; this ensures
it receives Ctrl-C and can stop its child before removing the temporary data.

It gives the child a temporary data directory and home, chooses a free
harness/webhook port pair, installs only the repository's fake engine, prints
the URL, PID, data directory, and persistent log path, then stays attached to
that exact child. The parent shell and the user's later.dog data are
untouched. Only `FAKE_CLAUDE_*` variables cross from the launcher's
environment into that child, so a recipe can script the fake engine's mode,
replies and tool calls without writing a wrapper CLI. Live calls add one
exception: `LATERDOG_OPENAI_LIVE_URL` crosses when it is a loopback
`http://127.0.0.1:PORT` (the fake GPT-Live that
`node --experimental-strip-types server/testing/fake-openai-live.ts` prints),
and `LATERDOG_OPENAI_LIVE_KEY` crosses only with it, so that key can only ever
reach the fake.

Pass the printed URL explicitly from a second terminal:

```sh
pnpm control:laterdog doctor --url http://127.0.0.1:PORT
```

Mutating commands refuse silent port discovery. This prevents a verification
recipe from sending messages to the user's running app by accident.

## Drive

Use only mapped, tested commands:

- [Chat turns](chat-turns.md)
- [Conversation context compaction](context-compaction.md)
- [Work summaries and engine hooks](digests.md)
- [OpenAI-compatible structured tools](openai-tools.md)
- [Per-bot tool selection and local-model checks](tool-selection.md)
- [Bot setup, model scope, and file continuity](bot-continuity.md)
- [The main dog](main-dog.md)
- [Profile proposal and credential-card lifecycle](proposal-cards.md)
- [Desktop progress, thread receipts and teammate names](desktop-polish.md)
- [Full Access without duplicate approvals](full-access.md)
- [Exact command allowlist UI and saved rules](command-allowlist.md)
- [Peer approval denial, expiry, and cancellation](peer-approvals.md)
- [Waiting for an occupied desktop](computer-wait.md)
- [Chat UI, driven headlessly](chat-ui.md)
- [Welcome flow](onboarding.md)
- [Channels](channels.md)
- [In-chat team coordination](room-coordination.md)
- [Engines and Doctor](engines.md)
- [Claude coordination and turn-scoped tools](claude-tool-lifecycle.md)
- [Codex bot instructions](codex-instructions.md)
- [Codex browser routing and native search](codex-browser-routing.md)
- [Codex helper event isolation](codex-helpers.md)
- [Qwen model route selection](qwen-models.md)
- [Team backups](team-backups.md)
- [Sharing one dog](team-sharing.md)
- [The organization library](org-library.md)
- [Preset bots](presets.md)
- [Sections](teams.md)
- [Full workspace backups](workspace-backups.md)
- [Organization library: the desktop channel](desktop-library.md)
- [Fleet: many workspaces on one server](fleet.md)
- [Workspaces screen and the fleet agent](workspaces.md)
- [Shared-workspace trust: loopback, card answerers, decision log](shared-workspace-trust.md)
- [Shared-workspace governance: bot visibility and admin activity](shared-workspace-governance.md)
- [Usage ledger](usage-ledger.md)
- [Bounded built-in tool results](tool-results.md)
- [Memory: recall, upkeep and the tidy-up](memory-layer.md)
- [Spend cap and sell prices](spend-cap.md)
- [Stability sweep: sends, approvals, updates, errors and a full disk](stability-sweep.md)

`control-laterdog ui` ([Chat UI, driven headlessly](chat-ui.md)) drives the real
renderer in a headless Chrome by accessible name, so composer sends, transcript
rows, tool chips and server feature flags are provable from the command line.
Other renderer-only behavior—Settings, sidebar drag-and-drop, the VM modal, the
built-in browser panel, and updater UI—is still not proven by the harness. Use
the relevant Electron/package smoke test and state that limitation. Add a map
entry only after the shared control surface can really drive it.

The [MCP sign-in fixture](mcp-sign-in.md) checks remote sign-in, callback URL
paste-back, MCP tools and logout cancellation through the real settings panel
and a synthetic OAuth provider in a disposable workspace.

The [Whop fixture](whop.md) checks that Whop sits in Apps like any other app,
then its setup, cancellation, denied consent, discovery failures, reconnect and
disconnect using that same registry and a synthetic provider, without accessing
a real Whop account.

The [Connected Apps OAuth fixture](connected-apps-oauth.md) checks blocked-popup
recovery, safe authorization links and abandoned-account retries through real
renderer components and isolated HTTP routes.

The [loading screen and tray smoke](startup-tray.md) checks the startup close
button, hidden handoff, tray restore, and Quit in a disposable Electron profile.

The [optional organization connection notes](organization-settings.md) cover
the desktop client, its native entry link and policy tests; there is no
Organization page.

The [personal Cloud account notes](cloud-account.md) cover the desktop Cloud
client's contract and node tests. [Desktop sign-in](desktop-signin.md) covers
signing in on the Mac with an email and a code while preserving the selected
workspace, plus deliberate Cloud connection and backup-copy actions.

The [embedded server recovery smoke](desktop-server-recovery.md) crashes real
Electron-owned fixture servers, verifies bounded recovery and private access,
and proves quit cancels recovery without replaying an interrupted fixture turn.

The [external runtimes recipe](external-runtime.md) proves a bot's standing
comms capability from `external-runtimes.json` against a disposable server and
the fake engine: scope, on-demand token reads, and immediate delegation drain.

The [cloud preview fixture](cloud-preview.md) mounts the real Computer panel
against an isolated server for image decoding, loading, and recovery UI checks.

The [VPS recovery fixtures](vps-recovery.md) reproduce preview/startup contention
and Docker-over-SSH timeout cleanup without contacting a real server.

The [local computer launch regression](local-computer-launch.md) starts the
host CUA gate through real Electron in a disposable home, without opening the
desktop app or controlling the user's computer.

The [remote desktop viewer fixture](desktop-viewer.md) checks the bundled
noVNC page, authenticated WebSocket proxy, desktop input, reconnect and logout
against an isolated server, synthetic desktop and VPS SSH forward.

The [bot settings fixture](bot-settings.md) checks profile saves, standing
instructions, history restore, skill/memory refresh, and stale-response isolation.

The [hosted Slack management fixture](hosted-slack-management.md) checks the
Admin link route: hosted-only availability and the member-readable route
module.

The [rich tables fixture](rich-tables.md) checks Markdown tables and message-scoped
CSV/TSV previews, large-file virtualization, sorting, search, export and keyboard
interaction in a disposable workspace.

The [people invitation fixture](people.md) checks hosted workspace sign-in,
roles and device revocation through the real HTTP API with a stubbed email
service, and the `laterdog access` command. The app has no People page.

The [sidebar fixture](sidebar.md) checks archive and delete confirmations, their
default focus, keyboard wrapping and focus return against two disposable bots.

The [independent threads fixture](threads.md) checks nested sidebar navigation,
per-thread models, simultaneous direct conversations and thread-scoped Stop.

The [mobile generated-image checks](mobile-generated-images.md) cover native image
attachments and message-scoped download authorization using isolated fixtures.

The [guarded external messages fixture](guarded-messages.md) checks atomic
branch and approval preconditions, retry receipts, and refusal to queue or
steer messages from external interfaces. It also verifies bounded request
lineage snapshots, Chief continuations and exact-execution Stop without
interrupting a newer request.

The [right-to-left fixture](bidi.md) checks per-block direction in bot replies
and per-line direction in sent turns, with code pinned left-to-right.

The [routines fixture](routines.md) checks confirmed proposals, manual and
scheduled runs, central run logs, List/Calendar views, and bot-scoped routines
using the real renderer and an isolated fake-engine server.

The [interval restrictions recipe](interval-restrictions.md) checks weekday and
time-window limits on scheduled routines in that same disposable fixture.

The [server settings recipe](server-settings.md) checks browser provider sign-in
with an offline CLI and custom-domain validation without touching live accounts.

The [engine setup preview](engines-ui.md) checks onboarding's engine list and
the Accounts list with sample statuses, responsive layouts, theme contrast and
status refreshes.

The [Claude account recipe](claude-account.md) checks sign-out, cancellation and
retry against an offline Claude CLI confined to a disposable home.

The [provider recovery recipe](provider-recovery.md) verifies real Grok image
transport and Claude authentication against loopback APIs, plus scoped thread
approvals and provider safety errors in an isolated desktop UI.

The [automatic recovery fixture](automatic-recovery.md) checks opt-in, one-shot
backup model dispatch after proven pre-prompt ACP failures, preserving the
conversation, approval level and Stop/new-message precedence.

The [skill approval lifecycle recipe](skill-approval-lifecycle.md) checks Deny,
missing staged records and active-thread deletion in two isolated app windows,
including the surviving conversation and sending again without deleting the bot.

The [Codex account recipe](codex-account.md) checks account switching against an
offline Codex CLI whose identity is synthetic and whose credential directory is empty.

The [ChatGPT plan recipe](chatgpt-plan.md) checks the separate official OAuth
flow, credential rotation, account ownership, and native Responses routing.

The [mention fixture](mentions.md) checks candidate selection, composer highlighting,
sent mentions, multiline scrolling and responsive wrapping in real chat views.

## Installed app

A release is checked the way a new user meets it, never by opening it over this
Mac's own later.dog:

```sh
scripts/sealed-installed-app.sh v0.3.17
```

It downloads the release, checks the zip against `SHA256SUMS.txt` and the
updater's `latest-mac.yml`, checks the signature, notarization and Gatekeeper's
verdict, then starts the app with a temporary home; drive it through the
printed devtools port. Setting `HOME` alone is not enough on macOS: the app
finds its data folders through Foundation, which ignores `HOME`, so a plain
`HOME=… later.dog` opens the person's real dogs and sign-ins. The script sets
`CFFIXED_USER_HOME` as well and runs the app in a sandbox that cannot reach the
real later.dog data at all. The copy inherits this Mac's Accessibility and
Screen Recording grants, so its dogs never get a task on "this Mac". Ctrl-C ends
the free trial it holds, stops it and removes its temporary folder.

An update in place is checked from the release before:

```sh
scripts/sealed-update-check.sh v0.3.21
```

The older copy stages the newest release by itself; the script quits it without
"Restart to update", so macOS installs the update and relaunches nothing, then
reopens the updated copy on the same temporary home and checks its data files.
Never click "Restart to update" in a copy: the relaunch comes from Launch
Services, outside the temporary home, onto the real data. This script runs
without the sandbox profile, which blocks the installer's launchd job, and
reports any file that changed in the real later.dog folders.

## Evidence

The [persistence responsiveness benchmark](persistence-performance.md) measures
synthetic message/log bursts and history scans, with isolated chat, visibility
and packaged-worker checks. It is not a production capacity qualification.

The [backup responsiveness benchmark](backup-responsiveness.md) compares in-process
and worker exports using synthetic data, with isolated backup workflow checks.

The [Japanese desktop font recipe](japanese-desktop.md) checks real Firefox and
XFCE glyph rendering in disposable managed desktops, including fresh recreation.

The [Podman Firefox sandbox recipe](podman-firefox.md) checks the capability set a
managed desktop keeps so Firefox can start, with before/after acceptance evidence.

The [Hetzner launch record](hetzner-launch-2026-09-07.md) is a dated self-hosting
run on a disposable VPS: what passed, what was corrected, and what it does not prove.
The [installed release record](installed-release-2026-10-12.md) does the same for the
macOS builds people download, run sealed with `scripts/sealed-installed-app.sh`; the
[0.3.28 record](installed-release-2026-10-14.md) adds voice and the in-place update.

Keep the JSON from `wait` and `messages`, the exact command sequence, and the
fixture's printed log path. Evidence must show both the action and the resulting
state. A green unit test alone does not prove a user workflow.

## Cleanup

Interrupt the `launch` process with Ctrl-C. It stops the exact child it owns and
removes only its temporary data directory. The server log remains at the
printed path. Never kill processes by name and never delete a broad temp root.
