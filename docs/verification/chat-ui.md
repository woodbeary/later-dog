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

It runs when an agent-browser binary resolves and is skipped with a printed
reason otherwise; `LATERDOG_UI_E2E=1` forces the verified download. The `ui-smoke`
job in `.github/workflows/ci.yml` runs every renderer test in `scripts/testing`
on Ubuntu 24.04 and uploads the screenshots; it is not one of the required checks.

The chat header holds the dog's pill, the account, the live-call chip and Find
(⌘F). It has no **More** menu, export, usage or computer button.

## Quiet dog lines, routine line, mentions, renames and approvals

A dog that hands work to another dog leaves one small grey line in the person's
chat: `Messaged ◯ Name`, or `2 messages with ◯ Name` when repeats sit together.
Older `Messaged @Name` rows (the dog-to-dog channel kind) read the same way and
open a read-only view of the exchange with a Close chat button; a hand-off to a
teammate opens that teammate's chat. A routine a dog creates reads
`Created routine ⏲ name` and opens that routine in Routines. An answered
permission folds to `Allowed once`, `Always allowed`, `Allowed for this chat`
or `Denied` with the tool's short name; the open card offers Allow once
(primary), Don't allow, and then, set apart and outlined, Always allow. The
exact command shows open in a mono block of capped height, one plain line under
the lasting choice says how far it reaches, and the dog's sidebar line reads
`Waiting for you: <action>`. Don't allow always hands the engine the same fixed
denial (`server/laterdog/person-denied.ts`), whatever text the client sent. Only
the Claude, Codex and ACP drivers pass that text on; the OpenAI-compatible chat
drivers (`server/drivers/chat-tool-approval.ts`, used by Grok, Mistral, MiniMax,
Cerebras and other OpenAI-compatible engines) drop it, so those engines see a bare
refusal. Always allow on a dog's own chat counts for that chat only; from a group
chat it is saved on the dog, so it counts in group chats and in new chats. A card
is labelled Always allowed only once the grant is really on the dog.

Names are read by dog id, and the server keeps a dog's earlier names
(`formerNames`), so a rename shows everywhere (sidebar, lines, mentions, the
exchange header, room labels) while old message text stays as written.

```sh
pnpm exec vitest run src/lib/quiet-lines.test.ts src/lib/dog-refs.test.ts \
  src/components/QuietLines.test.ts src/components/ApprovalCard.test.ts \
  src/components/PendingApproval.command-allowlist.test.ts src/components/SidebarBotListItem.test.ts \
  src/lib/mentions.test.ts server/laterdog/rename-everywhere.test.ts \
  server/laterdog/rename-capability.test.ts server/laterdog/answer-scope.test.ts
```

For the screen, launch `ui launch` with `FAKE_CLAUDE_ROOM_PLAN` pointing at a
plan that has one dog call `send_to_bot`, `propose_routine` and
`propose_profile` (its own new name) and answer the cards it raises from the
approval panel. `scripts/testing/exchange-preview.tsx` mounts the real chat
against fixed data, including an older channel exchange, for the read-only view.

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

## Voice button and dictation cancel

With a fresh `ui launch` handle in `$H`, run:

```sh
pnpm control:laterdog ui eval --ui "$H" --js "$(cat scripts/testing/voice-button.js)"
pnpm control:laterdog ui eval --ui "$H" --js "$(cat scripts/testing/dictation-escape.js)"
```

`voice-button.js` opens Pepper and checks that the composer shows exactly one
voice button with no mode menu, that pressing it in the browser preview (which
has no Mac speech recognition) shows "Voice call unavailable" with a plain
reason, and that no key field appears and no Live request is sent.

`dictation-escape.js` stubs a Mac speech bridge, remounts the app in the same
page so it sees dictation, types text, starts dictation, feeds a partial
transcript, presses Escape and checks that the earlier text is back exactly and
listening stopped. Reload the preview afterwards. Neither script opens the
microphone or proves real-audio acceptance.

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
