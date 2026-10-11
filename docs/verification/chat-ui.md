# Chat UI, driven headlessly

The `ui` group of `control-laterdog` drives the real React renderer — the same
`<App/>` the desktop shell loads, mounted by `scripts/testing/threads-preview.tsx`
— in a headless Chrome through the agent-browser binary the harness pins
(`server/browser-engine-release.ts`, implementation in
`scripts/testing/control-laterdog-ui.ts`). Everything it touches is disposable: the
fake-engine fixture from `launch`, a Vite preview of the app, and one browser
session whose `HOME` is the fixture's data directory. The user's app on port
8799 and `~/.laterdog` are never involved.

## Launch

```sh
node --experimental-strip-types scripts/control-laterdog.ts ui launch \
  --tool-calls '[{"name":"Bash","input":{"command":"echo hi"},"ok":true}]'
```

Run it in the foreground so Ctrl-C reaches it. On first use it downloads the
pinned agent-browser release (size and SHA-256 verified) and its Chrome for
Testing into `.laterdog-scratch/verify-tools` (gitignored); later launches reuse
them. `LATERDOG_AGENT_BROWSER_PATH` and `AGENT_BROWSER_EXECUTABLE_PATH` take
precedence when set. The launcher then starts the fixture, pins its language
to English (`PATCH /api/config`), creates Pepper through the same `new-bot`
path as [Chat turns](chat-turns.md), mounts the preview, opens it in a headless
session named `laterdog-ui-<port>`, and prints a handle:

```json
{
  "ok": true,
  "ui": "/tmp/laterdog-verify-data-XXXXXX/ui.json",
  "url": "http://127.0.0.1:PORT",
  "previewUrl": "http://127.0.0.1:5178/__threads.html",
  "botId": "…", "dataDir": "…", "logPath": "…"
}
```

`--tool-calls` and `--mode` script the fake engine (`FAKE_CLAUDE_TOOL_CALLS`
and `FAKE_CLAUDE_MODE` in `server/testing/fake-claude-cli.ts`). Pass `ui.json`
to every other verb as `--ui`; there is no discovery, so a recipe cannot drive
a browser it did not launch.

## Drive

```sh
H=/tmp/laterdog-verify-data-XXXXXX/ui.json
pnpm control:laterdog ui flag --ui $H --set features.showToolCalls=true --dry-run
pnpm control:laterdog ui flag --ui $H --set features.showToolCalls=true
pnpm control:laterdog ui snapshot --ui $H --interactive
pnpm control:laterdog ui type --ui $H --name "Message Pepper" --text hello
pnpm control:laterdog ui press --ui $H --keys Enter
pnpm control:laterdog ui wait-settle --ui $H --timeout 60
pnpm control:laterdog ui snapshot --ui $H
```

`snapshot` returns the accessibility tree with `@eN` refs and a `refs` table
of accessible names and roles. `click` and `type` take `--ref @eN` or the
exact `--name`, and refuse an ambiguous name by listing the candidates. `flag`
patches server feature flags (`PATCH /api/config` with `features`); the
renderer picks the change up over SSE. `wait-settle` succeeds only when the
shared `wait` tool reports the seeded bot settled, no bot in `GET /api/bots`
is busy, the transcript shows the newest server message (its `data-mid` row)
and the browser reports network idle; on timeout it exits non-zero with the
last state it saw.

Expected: the interactive snapshot has exactly one `textbox "Message Pepper"`.
After the turn, the `log "Conversation with Pepper"` landmark contains
`StaticText "hello"`, a `StaticText "Bash"` tool chip (the scripted call) and
`StaticText "hello from fake claude"` (the fake engine's reply). The chip is
present only because `showToolCalls` is on; the sidebar row previews the reply
too, so read the transcript landmark, not the whole tree.

## Evidence

```sh
pnpm control:laterdog ui screenshot --ui $H --out .laterdog-scratch/verify-evidence/chat-ui.png
pnpm control:laterdog ui console --ui $H
pnpm control:laterdog ui eval --ui $H --js "document.title"
```

Keep the `wait-settle` JSON, both snapshots, the screenshot and the printed
server log path. The console output must contain no `error` entries.

When the recipe passes, the screenshot shows the isolated app with Pepper's
greeting, the sent "hello", a passed Bash chip and the fake reply.

The permanent form of this recipe is `scripts/testing/control-laterdog-ui.e2e.test.ts`:

```sh
LATERDOG_UI_E2E=1 pnpm exec vitest run scripts/testing/control-laterdog-ui.e2e.test.ts
```

The asserted recipe also runs a real fixture health check and verifies that
clicking a deliberately missing control fails. The old execution timeline is no
longer shown above chat.

`scripts/testing/usage-details-ui.e2e.test.ts` checks the header's **More** menu,
usage breakdown, clipboard success and refusal, and responsive geometry at
390, 800, 1100 and 1600 px. It checks that opening bot settings folds the sidebar
without changing its saved density and closing settings restores it. Evidence
includes screenshots and a `.usage-details.json` next to the fixture log.
These are renderer checks, not native Windows caption-button verification.

It runs when an agent-browser binary resolves and is skipped with a printed
reason otherwise; `LATERDOG_UI_E2E=1` forces the verified download. The `ui-smoke`
job in `.github/workflows/ci.yml` runs it on Ubuntu 24.04 and uploads the
screenshot; it is not one of the required checks.

## Thinking timer across thread switches

`scripts/testing/thinking-timer-ui.e2e.test.ts` holds the working row's
elapsed readout to the server's `turnStartedAt` stamp. It launches the full
app with the fake engine in `hang` mode, so a sent turn stays officially in
flight and the bot stays busy with no reply arriving. A second thread is
created through the same `POST /api/bots/:id/tasks` the sidebar's
**New thread** dispatches, the bot's thread list is expanded through its
chevron, and the test switches to the idle thread and back mid-turn. The
readout before the switch, the readout after the return, and the stamp on
the wire are compared: the count must resume from the stamp (13+ seconds
in), never from the moment of re-selection, and the stamp itself must not
move while the turn runs. A screenshot of the anchored readout is kept as
evidence.

Groups never showed the readout at all — their turns run on the group's
busy slot, not on a member's task, so there was no stamp to count from.
The second test in the same file gives groups their own: a one-member
group is created through the same `POST /api/groups` the sidebar's group
creation dispatches (with setup completed, so the composer is live at
once), a message routes to the default responder, and the group's claim
of its speaker — the `busyBotId` transition the server stamps as
`turnStartedAt` on the group, cleared again when the group goes idle —
must appear in the readout. The test switches to the member's 1:1 thread
and back mid-turn and holds the resumed readout to the same claim stamp,
keeping a second screenshot.

```sh
LATERDOG_UI_E2E=1 pnpm exec vitest run scripts/testing/thinking-timer-ui.e2e.test.ts
```

## In-flight reply text

The desktop shows a reply once it is finished; while a turn runs, the chat
shows the bot's busy state. The renderer keeps no streamed text:
`runtimeFrameAction` in `src/state/store.tsx` passes only the model-variant
frames on, and `src/state/store.test.ts` checks that a reply or reasoning
delta leaves the store state unchanged. `src/components/ChatView.follow.test.ts`
checks that the finished reply still moves a following transcript to its end.

```sh
pnpm exec vitest run src/state/store.test.ts src/components/ChatView.follow.test.ts
```

## MCP access

Runtime mounting, direct/channel turns, busy-state rejection and revoked-session
imports are exercised by `server/mcp-selection.e2e.test.ts` against disposable
fake-engine servers.

## Cleanup

Interrupt `ui launch` with Ctrl-C. It closes the browser session (waiting
until agent-browser no longer lists it), then the preview, then the fixture,
and removes only its data directory; the server log stays at the printed path
and the tools directory keeps the downloads. Every verb refuses a handle whose
launch has stopped.

## Live key prompt cancellation

With a fresh `ui launch` handle in `$H`, run the delayed-key-save regression:

```sh
pnpm control:laterdog ui eval --ui "$H" --js "$(cat scripts/testing/live-key-lifecycle.js)"
```

It submits the real key form, then dismisses it or switches chats by keyboard-style
activation before the synthetic save resolves. Both results must show
`oldPromptDetached: true`, `microphoneStarts: 0`, and `phase: "idle"`. The script
clears only the disposable fixture's Live key, stubs credential saving and media,
and restores the bridge and call mode in `finally`. It never saves a real key or
opens the microphone; it does not prove real-audio acceptance. Stop the launcher
as described above.

## Queued edits and Claude update recovery

The queued-message Edit action must remove the server's held send before
returning its text to the same thread's draft, ahead of any existing text.
To exercise the desktop Claude update card without an actual provider,
launch an isolated UI with `FAKE_CLAUDE_MODE=api-error` and
`FAKE_CLAUDE_API_ERROR="API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required."`.
Send one short message, then click **Update Claude for me**. The fake updater
must report its synthetic version and the card must offer **Retry**, even
when a digest follows the error. This proves the update request and recovery
UI, not a real Claude installation or a successful provider retry.

## What this proves, and what it does not

Proven: the real composer sends a turn on Enter, the fixture runs the scripted
fake-engine turn, the transcript renders the sent text, the tool chip and the
reply, and a server-side feature flag reaches the renderer live — all in a
Chromium page, through accessibility names, with no mouse coordinates.

Not proven: the Electron shell (menus, preload bridge, screen capture,
dictation), a real provider, Settings, sidebar drag-and-drop, the VM modal, the
browser panel and updater UI, and anything `Show threads` gates (that toggle is
renderer localStorage, outside `ui flag`). `AGENT_BROWSER_HEADLESS=1` is set
for consistency with the harness, but agent-browser 0.37.0 is headless by
default and reads `AGENT_BROWSER_HEADED` to opt out.
