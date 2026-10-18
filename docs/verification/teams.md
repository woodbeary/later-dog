# Teams and shared instructions

A team is a named membership group. It can be empty. Group chats are
conversations, and Templates is the catalog that creates new teams and bots.
The sidebar and Team map use the same persisted team list. Existing bot and
group-chat labels migrate automatically; clearing a team's shared instructions
or moving its last bot does not remove the team.

Shared instructions are still stored and carried in team packages, but they no
longer reach any dog's prompt and the pack map has no editor for them or for
pack memory.

Run the isolated lifecycle checks:

```sh
pnpm exec vitest run server/team-lifecycle.e2e.test.ts server/section-context.test.ts server/store.test.ts src/lib/team-map.test.ts --maxWorkers=2
LATERDOG_UI_E2E=1 pnpm exec vitest run scripts/testing/team-lifecycle-ui.e2e.test.ts scripts/testing/team-template-ui.e2e.test.ts --maxWorkers=1
pnpm exec vitest run scripts/testing/team-computers-fixture.test.ts
pnpm exec vitest run server/index.test.ts -t "creates team computers|shares one team computer" --maxWorkers=1
```

The server test uses `launchVerificationServer`, sends a sample conversation,
creates an empty team, moves two existing bots, saves shared instructions,
renames the populated team, adds and removes members, then empties and renames
it again. It imports a legacy template with a colliding name and restarts the
exact disposable server. It checks retained instructions and conversation
messages, archived bots moving to General when their team is deleted, and
explicit empty-team deletion. API requests and `control-laterdog` wait/messages
results are kept beside the fixture log in `*.team-lifecycle.json`.

A second real process restart uses legacy bot and group records needing
migration beside a deliberately malformed team registry. Startup keeps both
conversations readable and persists their task migrations, logs a diagnostic,
and leaves the malformed file byte-for-byte unchanged. Later team and shared
instruction writes still fail closed until that file is repaired.

The renderer test uses `control-laterdog ui launch`, opens **Create team**, and checks
that renaming preserves the sidebar's collapsed state and ordering. It adds
two bots with **Add dogs**, edits membership, and creates a bot directly in the
team. Dismissing that pending creation must retain unsaved membership edits and
select the created bot when its response arrives. It edits shared instructions
and reloads. A second fixture client moves the bots out; live updates retain the
empty team. Rename preserves instructions; delete confirms that the team's
instructions will be removed. A delayed, failed deletion cannot be submitted
twice and remains retryable; confirmation focus stays contained and returns to
its trigger when dismissed. It captures
`.laterdog-scratch/verify-evidence/team-lifecycle.png` before deletion.
New lifecycle labels use the existing string catalog; untranslated packs fall
back to the English labels without changing or regenerating other translations.

Pack map has no entry in the current app: it opens only from a conversation's
place card when a team computer is already assigned, and team computers are
created only inside Pack map. Its renderer checks (`team-canvas-ui` and
`team-computers-ui`) were retired in 0.3.27 rather than kept against a screen
people cannot reach. `src/lib/team-map.test.ts` still covers its layout logic.

The focused `server/index.test.ts` cases run the real server against a local
HTTP Boat stand-in, with a disposable fake token and no paid account or container
engine. They verify explicit cost acknowledgement, invalid/foreign-origin
request denial, read-only inventory, durable failed-create records, same-id
retry without a second machine, concurrent provisioning rejection, and busy-team
assignment rejection. Assignment consent and the resulting registry file are
checked; this is not a full server-restart assertion. Opening a shared desktop
requires taking human control first.

A second case confirms that Auto bots' direct and room turns receive the same
Boat ID, while an explicit Off bot receives no computer. The real shared-resource
lock rejects overlapping work and lifecycle changes; human control is shared
across the team's bots, while a bot's control capability cannot impersonate
another bot and is revoked after its turn. Removing the simulated provider
machine causes a clear failure, never an automatic paid replacement. These
checks prove server routing and ownership, not actual Boat provisioning or
remote desktop operation.

For a separately driven computer-use preview, run:

```sh
node --experimental-strip-types scripts/testing/team-computers-preview.ts
```

The printed `previewUrl` is disposable. `boatFixtureApi` exposes a fixture-only
`GET /__fixture` receipt of provider calls; `POST /__fixture` with
`{"refuseCreate":true}` enables the simulated 429 response, and false clears it.
The launch hook accepts only a literal `http://127.0.0.1:PORT` and installs a
fixed fake token. It cannot inherit a real Boat token or use a remote provider.
Ctrl-C stops the owned renderer/server and local provider. Guest bootstrap
commands are acknowledged by the stand-in but never execute.

On 2026-09-13, a separate native computer-use pass against this preview created
a named computer, used its desktop hold/release controls, and dragged its shelf
handle onto General. The real pointer drag opened the correct assignment
confirmation with **Cancel** focused; this verified the shelf's native pointer
capture after replacing HTML drag-and-drop. The confirmation clearly explains
shared files/accounts and that only one bot can use the desktop at a time.
This native pass does not prove physical touch input, a paid provider's
provisioning behavior, or a live remote desktop stream.

The owner API keeps the existing `/api/sidebar-sections` name for older clients:

- `GET` returns `{ sections: string[] }`.
- `POST { name, botIds?: string[] }` creates a named team or moves the supplied
  bots into it. Omitted/empty `botIds` creates an empty team. An empty name with
  selected bots moves them into General. Chief conflicts change no memberships.
- `PUT ?section=NAME { addBotIds: string[], removeBotIds: string[] }` updates
  membership in an existing team. Removed bots move to General. Invalid or
  stale membership changes are rejected without partially applying the move.
- `PATCH ?section=NAME { name }` renames a team, including its bots, archived
  bots, group chats, shared instructions, management grants and assigned team
  computer. It cannot merge into an existing team or rename during active work.
- `DELETE ?section=NAME` removes the team and its shared instructions while
  retaining bots, archived bots, group chats and their conversations in General.
  Finish active work and unassign any team computer first. Chief conflicts
  reject the deletion rather than changing leadership.

The registry shares the atomic section-context file so rename/delete cannot
split a team's name from its instructions. Team labels are remembered before a
bot write; a storage failure may leave an empty team, but cannot partially move
the selected bots. This does not change bot communication permissions.

Both fixtures own their fake engine, temporary home and data directory. Cleanup
stops only their own child processes. Never run these requests against the live
app or copy live data into a fixture.
