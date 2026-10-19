# Sections

A section is a plain named group in the sidebar. It can be empty. Each header
shows how many dogs and group chats it holds; dogs and group chats without a
section sit under **Unassigned** (no header at all when there are no sections).
Sections keep the order saved on the server: drag a header, or press
Alt+Up/Down on it, and `PUT /api/sidebar-sections/order` saves the new order.
A dog moves with **Move to** in its menu, which can also start a new section,
or by dragging its row onto a section (group chats drag too); an empty section
shows "Drag dogs here". A section's menu
(right-click its header) has **Rename section** and **Delete**; deleting keeps
its dogs and group chats with their conversations. There is no pack map,
shared-instructions editor, **Add dogs**, **Share pack** or templates gallery,
and the **+** menu has only **New dog** and **New group chat**.

Shared instructions saved by older builds are still stored and still travel in
whole-section packages, but they reach no dog's prompt and nothing in the app
edits them.

## Checks

```sh
pnpm exec vitest run server/team-lifecycle.e2e.test.ts server/section-context.test.ts server/store.test.ts server/routes/sidebar-section-order.test.ts --maxWorkers=2
pnpm exec vitest run src/lib/sidebar-layout.test.ts src/lib/section-drop.test.ts src/components/AddDogSheet.test.ts src/components/Sidebar.header-menus.test.ts src/components/SidebarSectionHeader.test.ts
```

The server test uses `launchVerificationServer`: it creates an empty section,
moves bots in, renames it, empties it and deletes it, restarts the exact
disposable server, and checks a malformed section registry is left untouched
while writes fail closed. The renderer tests cover the partition (the main dog
sits in its own section like any dog and leads the pinned grid), which drops a
dog row may land on, the duplicate-name check on rename and the two-item
**+** menu.

In an isolated `control-laterdog ui launch` app, `POST /api/sidebar-sections`
with `{ "name": "Home" }` shows an empty **Home 0** with "Drag dogs here";
**Move to › Home** on a dog moves it (`GET /api/bots` shows `section: "Home"`);
the header menu's **Rename section** renames it for its dogs.

## Team computers

Section ("team") computers are gone from the app and no longer run any dog's
work. A dog in a section with an old team computer keeps its own computer: its
turns, Computer panel status, control and Open desktop are its own. The server
routes under `/api/team-computers` and their tests still exist, so an old box
can still be found until Settings lists it:

```sh
pnpm exec vitest run server/team-computers.test.ts scripts/testing/team-computers-fixture.test.ts
pnpm exec vitest run server/index.test.ts -t "creates team computers|keeps every dog on its own computer" --maxWorkers=1
```

## The owner API

The API keeps the `/api/sidebar-sections` name:

- `GET` returns `{ sections: string[] }`.
- `POST { name, botIds?: string[] }` creates a section or moves the supplied
  bots into it.
- `PUT ?section=NAME { addBotIds, removeBotIds }` changes membership; removed
  bots become unassigned.
- `PATCH ?section=NAME { name }` renames a section, including its bots,
  archived bots and group chats. It cannot merge into an existing section.
- `DELETE ?section=NAME` removes the section, keeping its bots, archived bots,
  group chats and conversations.

Both fixtures own their fake engine, temporary home and data directory. Never
run these requests against the live app or copy live data into a fixture.

Verified on 2026-10-18 for the finalize slice `d3-chief-packs-teams`; evidence in
`/Volumes/laterdog-phone/tmp/finalize-2026-10-18/d3-chief-packs-teams/`
(`01-sidebar-sections.png`, `05-move-to-picker.png`, `06-after-move.png`,
`10-section-menu.png`).
