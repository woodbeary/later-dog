# Sidebar

Launch `node --experimental-strip-types scripts/verify-sidebar.ts`. It creates
an isolated fake-engine server and two disposable bots, then prints a preview
URL. Open that URL, never the user's live app. Ctrl-C closes both servers and
removes only the fixture data.

The preview mounts the actual Sidebar and StoreProvider. Verify:

1. Right-click Sidebar Atlas and choose **Hide from sidebar**. It leaves the
   list at once with no confirmation, and **Hidden dogs 1** appears at the
   bottom. Expanding it shows the row; its menu offers Mark as Read or Unread,
   Rename Dog, Copy conversation ID, **Show in sidebar** and Delete.
2. **Show in sidebar** puts it back in its section and removes the group.
3. Right-click Sidebar Atlas and choose Delete. Cancel receives focus, leaves
   the bot intact and returns focus to the sidebar if the menu trigger has
   disappeared.
4. Repeat Delete and confirm. Only the disposable Atlas bot disappears; the
   remaining bots are unchanged and keyboard focus remains in the sidebar.

Static regression coverage in `src/components/SidebarBotListItem.test.ts` checks
the delete dialog's semantics and copy, the main dog badge and the
working/waiting indicators; `src/components/Sidebar.one-row.test.ts` checks the
menu order for shown and hidden dogs. This fixture covers the sidebar only; it
does not exercise Settings > Computers deletion or provider completion polling.
Those paths are covered by the computer-section and server Boat inventory tests.

## Like Grok Bot's sidebar

The sidebar follows Grok Bot's desktop sidebar (T7 study, D-LIVE-25, D-LIVE-29,
C-LIVE-16, C-LIVE-29):

- **Top row:** Search and **+** (New dog, New group chat). Search opens one
  dialog for dogs, group chats, apps, commands and messages. Hidden dogs show
  up only for a typed search, after the others, tagged **Hidden**; opening one
  does not show it in the sidebar again.
- **Pins:** pinned dogs are the avatar grid under the top row, main dog first.
  Drag one avatar onto another to reorder (kept on this computer, like the
  collapsed sections).
- **Sections:** sections come in the order saved on the server
  (`PUT /api/sidebar-sections/order`); every header shows its count; group
  chats and dogs without a section sit under **Unassigned**, and with no
  sections there is no header at all. Drag dogs and group chats between
  sections; drag a header, or press Alt+Up/Down on it, to reorder sections. An
  empty section says "Drag dogs here".
- **Rows:** a dog's menu reads Pin, Move to, Mark as Read or Mark as Unread,
  Rename Dog, Copy conversation ID, Hide from sidebar, then Delete (Replace with
  different dog… for the main dog). A group chat's menu has Move to, Mark as
  Read or Unread, Rename, Copy conversation ID and Delete. A waiting dog's line
  says what it waits for, on the icon rail too. Rename Dog edits the name in
  the row once; for a pinned dog or on the icon rail it opens the dog's name
  settings. A section order the server refuses snaps back to the saved one.
- **Hidden dogs:** a collapsed **Hidden dogs N** group at the bottom. Hiding
  only filters the list.
- **More unreads:** when unread rows are scrolled out of view, a pill above or
  below the list says how many and jumps to the nearest.
- **Footer:** your avatar (its menu has your plan usage, Get later.dog for
  iPhone, **Support** › Help Center, Send Feedback, Report a bug, Settings, and
  your AI accounts), the **Connect apps** pill, and the update button.
- **Shortcuts:** ⌘K and ⌘⇧F search, ⌘N new dog, ⌘, Settings, ⌘⇧M
  Connect apps (⌘⇧M mutes instead during a voice call), ⌘I message box,
  ⌘L quotes the selected text, ⌘B collapses the sidebar to the icon rail,
  ⌘⌥B, ⌘⇧I and ⌘⇧, show or hide the dog's details, ⌥↑/⌥↓ and ⌘1–9 follow the
  sidebar's visible order, ⌘[ and ⌘] go back and forward through the chats you
  opened, ⌘/ lists them all. Ctrl replaces ⌘ on Windows and Linux, where
  F12 opens DevTools so Ctrl+Shift+I stays the dog's details. Letters follow
  the printed key on any keyboard layout.

```sh
pnpm exec vitest run src/components/Sidebar.parity.test.ts src/components/CommandPalette.test.ts src/lib/app-shortcuts.test.ts src/components/MoreUnreadsPills.test.ts src/components/Sidebar.one-row.test.ts src/components/SidebarProfileMenu.test.ts server/routes/sidebar-section-order.test.ts src/components/Sidebar.rename.test.ts electron/menu.test.mjs
```

Hidden dogs still answer their own chat, but the server still leaves hidden
dogs out of group chats, peer messages and routines; making hidden a list
filter only on the server is a separate change.

## Sections and the main dog

Sections, their menu and the two-item **+** menu are in [Sections](teams.md).
`src/components/SidebarSectionHeader.test.ts` checks that the delete control
coexists with the header's context menu and does not nest inside the collapse
button. Deleting a section asks first; Cancel gets initial focus and its dogs
and group chats stay with their conversations.

The main dog carries a small badge on its avatar (no crown and no label line),
and its menu offers **Replace with different dog…** in place of Delete, which
opens **Choose a main dog** (search, every other visible dog, Cancel / Confirm).
Hiding the main dog is allowed. [The main dog](main-dog.md) covers the server
side; `src/components/MainDog.test.ts` and `src/components/SidebarBotListItem.test.ts`
cover the menu, the picker list and the badge.

## One row per dog and per group chat

Each dog and each group chat has one row and one conversation. There is no
thread tree, folder, New thread button, Active threads panel or pinned-threads
panel, and dog-to-dog exchanges are not listed (they open read-only from the
quiet line in a chat). A dog's dot, Waiting line, Queued line and unread dot
come from its one conversation only, so an old extra task never leaves a dot
that cannot be cleared. Notification taps, search results and thread links open
the dog or group chat, never a task switch.

Check it headlessly with `node --experimental-strip-types scripts/control-laterdog.ts ui launch`
([Chat UI](chat-ui.md)): give Pepper extra tasks and a folder through
`POST /api/bots/:id/projects` and `POST /api/bots/:id/tasks`, send in one extra
task with `control-laterdog send --task`, reload, and confirm the sidebar has no
`[data-sidebar-thread-row]`, `[data-sidebar-folder-row]` or
`[data-sidebar-activity-row]` and Pepper's row shows no unread dot.
`src/components/Sidebar.one-row.test.ts` and `src/components/Sidebar.rows.test.ts`
hold the same checks as unit tests.

In Settings → Appearance, **Notification sounds** controls the operating
system alert sound on this computer only; it does not disable notification
banners or the bot's own notification setting. `src/lib/notification-preferences.test.ts`
and `src/lib/notify.test.ts` cover persisted preferences, blocked storage, cross-window
reads after Settings unmounts, and the silent flag sent to the desktop bridge.
Actual operating-system sound delivery requires a native Electron smoke test;
the isolated browser cannot prove it.

In the desktop app every notification, on the Mac's own dogs or on a Cloud
home, goes through the native banner bridge (`window.laterdog.notifications`,
remote-safe in `electron/preload.cjs`, shown by `electron/desktop-notifications.mjs`).
Clicking a banner opens its dog or group chat. On macOS a banner for anything
but an approval or a takeover (`replyable` in `shared/notification.ts`, shared
with phone pushes) has a Reply field that sends through the normal send path
with a fresh sendId and leaves the window where it is. Closing the window on
macOS hides it, so live events keep reconnecting and banners keep coming until
the app quits. `electron/desktop-notifications.node-test.mjs` drives a fake
Notification class through click and reply, and
`scripts/testing/desktop-banners-ui.e2e.test.ts` runs a turn on the fixture
with a recording bridge (`__threads.html?desktopBanners`), replies from the
banner, and checks exactly one message with that sendId lands, even when the
reply is delivered twice. A real banner on screen, its Reply field and the
hidden window need a packaged app on a Mac and are not covered by these checks.
