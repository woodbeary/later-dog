# Sidebar confirmations

Launch `node --experimental-strip-types scripts/verify-sidebar.ts`. It creates
an isolated fake-engine server and two disposable bots, then prints a preview
URL. Open that URL, never the user's live app. Ctrl-C closes both servers and
removes only the fixture data.

The preview mounts the actual Sidebar and StoreProvider. Verify:

1. Click Archive Sidebar Atlas: Cancel receives focus by default.
2. Shift-Tab wraps to Archive; Tab wraps back to Cancel.
3. Escape closes the dialog, leaves `Drawer: open`, and restores focus to the
   Archive trigger. No bot is archived.
4. Right-click Sidebar Atlas and choose Delete. Cancel leaves the bot intact
   and returns focus to the sidebar if the menu trigger has disappeared.
5. Repeat Delete and confirm. Only the disposable Atlas bot disappears; the
   remaining bots are unchanged and keyboard focus remains in the sidebar.

Verified on 2026-09-05 against the isolated renderer. Static regression coverage
in `src/components/SidebarBotListItem.test.ts` checks dialog semantics/copy,
the main dog badge, role badges, and working/waiting indicators. The interaction checks
above are manual browser verification, not assertions made by those unit tests.
This fixture covers the sidebar confirmation and bot-row result only; it does
not exercise Settings > Computers deletion or provider completion polling.
Those paths are covered by the computer-section and server Boat inventory tests.

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
