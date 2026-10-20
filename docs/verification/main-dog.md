# The main dog

Every workspace has exactly one main dog: the dog the person talks to first.
The server keeps it as one pointer (`shared/main-dog.ts`). With no saved choice
it is the visible saved Chief of Staff from older builds (an unsectioned one
first, then by sidebar order), else the oldest visible dog, else the oldest dog.
The wire still carries it as `chiefOfStaff: true` on exactly one dog, so the
desktop and the phone agree without their own rule.

- `PATCH /api/main-dog` with `{ "botId": "…" }` moves it. `PATCH /api/bots/:id`
  with `{ "chiefOfStaff": true }` does the same; `false` on the main dog is
  refused with 409.
- `DELETE /api/bots/:id` on the main dog is refused with 409. Hiding it is
  allowed and it stays the main dog.
- Only the main dog gets one routing sentence in its prompt, and only when
  there is another dog to route to. It has no extra tools or authority.

## Check it

```sh
pnpm exec vitest run shared/main-dog.test.ts server/store.test.ts -t "main dog"
pnpm exec vitest run server/index.test.ts -t "main dog"
```

On an isolated fixture (`node --experimental-strip-types scripts/control-laterdog.ts launch`),
the starter dog is the main dog: deleting it returns 409, hiding it returns
200 and it still answers a message, and after `PATCH /api/main-dog` to another
dog the old one can be deleted.

## On the desktop

The sidebar marks the main dog with a small badge on its avatar; there is no
crown, no "Chief of Staff" line and no badge in the chat header. Its menu has
**Replace with different dog…** where other dogs have Delete. That opens
**Choose a main dog**: a search field, every other visible dog, and Cancel /
Confirm (Confirm stays off until a dog is picked). Confirming sends
`PATCH /api/bots/:id { "chiefOfStaff": true }` for the chosen dog, and the
badge moves. There is no "Make Chief of Staff" item on any dog. When the main
dog is pinned it leads the pinned grid.

```sh
pnpm exec vitest run src/components/MainDog.test.ts src/components/SidebarBotListItem.test.ts src/lib/sidebar-layout.test.ts src/components/ChatView.controls.test.ts
```

In an isolated `control-laterdog ui launch` app (2026-10-18, finalize slice
`d3-chief-packs-teams`): the starter dog showed the badge; its menu read
"Pin | Move to | Mark as Unread | Edit Profile | Duplicate | Copy conversation ID |
Archive | Replace with different dog…" while another dog's ended in Delete;
choosing Pepper in the picker moved `chiefOfStaff` to Pepper over the API, the
old main dog's menu got Delete back, and `DELETE /api/bots/<Pepper>` returned
409. Evidence: `/Volumes/laterdog-phone/tmp/finalize-2026-10-18/d3-chief-packs-teams/`
(`03-main-dog-menu.png`, `07-choose-main-dog.png`, `08-after-replace.png`,
`09-menus-after-replace.txt`).
The menu now reads "Pin | Move to | Mark as Unread | Rename Dog | Copy conversation ID |
Hide from sidebar | Replace with different dog…" ([Sidebar](sidebar.md#how-the-sidebar-is-laid-out)).
