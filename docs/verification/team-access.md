# Communication across packs and Chief setup authority

Peer discovery and communication cover reachable bots across packs in the
current workspace. `list_bots`, `list_room_targets`, consultation, delegation,
and coordination do not require matching sections or Chief `managedSections`
grants. Packs organize bots; they are not communication boundaries.

This is workspace-local discovery, not global discovery across accounts or
servers. Bots have visibility audiences rather than individual owner account
IDs. The source and recipient must have the same visibility audience, and
explicit `peers` restrictions still apply. Hidden bots remain excluded. A bot
cannot use a broad workspace roster to expose a more restricted bot or room
transcript. Each recipient keeps its own model, tools, and execution permissions.

Chief setup authority remains separate. A Chief's own team is in scope for
management. There is no settings control for additional teams: a Chief gains a
team it creates through an approved team setup, and the bot API
(`PATCH /api/bots/:id` with `managedSections`) still saves grants. Saved grants
keep working for management; specialists do not inherit them. Persisted empty
teams can be granted too, as can General. A new grant must name an existing team
exactly. Rename or delete an empty team revokes its old grants; recreating its
name never restores them. A no-op rename preserves management access.

Rooms created by a bot still land in that bot's own section. A bot may manage
only a room in its own section that it belongs to, with reachable members;
those members may come from other packs. Moving rooms between sections remains
a user action. Discovering a room or coordinating with its members does not
confer permission to read unrelated conversations or change another pack.

Run these checks against disposable fixtures only:

```sh
pnpm exec vitest run server/peer-roster.test.ts server/chief-of-staff.test.ts server/delegations.test.ts server/bot-overview.test.ts --maxWorkers=1
pnpm exec vitest run server/account-wide-roster.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/peer-allowlist.e2e.test.ts server/room-coordination.e2e.test.ts --maxWorkers=1
```

The fixtures cover cross-pack discovery and communication, nested room
handoffs, explicit peer restrictions, visibility boundaries, and withholding a
child result when peer access or room membership changes mid-task. Changing a
Chief's management grants alone does not revoke communication access.

Management grants persist before a team name is freed: a failed rename may
leave management access revoked, but never leaves a reusable name carrying old
authority. An active bot cannot give itself new team authority through an
unpaired loopback request, even with a forged Origin header; a paired owner or
packaged desktop is required.

These fixtures use scripted providers, not live model judgment. They do not
prove that the installed app has updated or that a real bot completed a live
cross-pack request. Existing coordination depth, lineage, and approval limits
still apply.
