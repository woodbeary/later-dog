# Cloud computers for dogs — how the others do it, and what later.dog builds

A dog that keeps working after the laptop closes needs a computer that is not the laptop. This page compares how the
products later.dog is measured against give an agent its own machine, lists what later.dog already has, and sets out the
design for a per-dog cloud computer on the operator's own Cloudflare account. Facts are from the research behind
`docs/laterdog/roadmap.md` (Grok Bot's reconstructed client, Anthropic's and OpenAI's documentation, Cloudflare's
Containers and Sandbox documentation, all read 2026-10-06; Cloudflare's scheduling-policy, snapshot and limits pages read
2026-10-08). The design below is direction b of the roadmap. It is built and verified live: [deploy/laterdog/computers](../../deploy/laterdog/computers/README.md) has the service, the one-command deploy and the measured timings.

## How the others do it

| | Where the agent runs | What it can touch | State | Sleeps when idle | Who pays |
| --- | --- | --- | --- | --- | --- |
| **Grok Bot** | One cloud VM ("box") per bot, brokered by Cursor; the harness runs on it; the Mac is a thin client plus an opt-in local-exec daemon | A full desktop (browser, terminal, apps) the person can take over; the Mac only behind approval cards | Server-side (agent DB, memory, routines, skills) synced to object storage, so the box is a rebuildable cache | Yes | Cursor's weekly allowance |
| **Claude Code cloud** | An Anthropic-managed sandbox per session, from an environment (setup script, network policy) | The cloned repository and allow-listed network; GitHub through a proxy that injects credentials | Per session; a routine starts a fresh one | Yes (sessions end) | The person's Claude plan |
| **Codex Cloud** | An OpenAI-managed container per task, from a published environment (install script, network secrets injected by proxy) | The repository and allow-listed network | Per task; the result is a diff | Yes (tasks end) | The person's ChatGPT plan |
| **later.dog today** | The Mac (This PC), a local VM, a Docker container, a BYO VPS over SSH, or a Boat cloud box; the built-in browser everywhere | Whatever that computer is; every action behind approval cards unless the dog is off-leash | Desktop data dir; the cloud supervisor's jobs in R2 | The supervisor container does; the Mac does not | The person's own subscriptions; Boat bills separately |

Two lessons carry over. Grok Bot keeps the **state off the box** so a box can be thrown away and rebuilt — later.dog's
supervisor already does this with R2. And every product that feels effortless **sleeps the machine** and wakes it on
demand, which is what keeps a per-agent computer affordable.

## Design: a dog's computer on Cloudflare

One Durable Object and one container per dog that asks for a cloud computer, on the operator's own Cloudflare account,
built from the same pieces the supervisor already proved. Boat stays available as an optional provider.

- **Image:** Debian with Xvfb + a small window manager, Chromium, the Cua driver the VPS computer already pins
  (`server/container-computer.ts`), and noVNC for the live view (the desktop bundle already ships noVNC for VM computers).
- **Scheduling:** the Containers `durable_object` scheduling policy (public beta). Each dog's Durable Object starts its own
  container and picks the image and instance size when it does; the policy needs the Durable Object to use SQLite storage.
- **Control:** a Worker in front of each dog's Durable Object, the way `deploy/laterdog/cloudflare` fronts the supervisor:
  bearer-checked HTTPS for exec / screenshot / input (the shape of the Boat driver's REST calls in `server/boat.ts`), and a
  WebSocket proxied straight to noVNC for **Dog's computer → Computer**, so the person can watch and take over.
- **Sleep and wake:** after an idle window with no command and no viewer, the dog's object snapshots the container's
  filesystem and stops it; the next tool call starts it again from that snapshot (a cold start is tens of seconds, so the
  panel shows "Waking up…" instead of an error).
- **State:** filesystem snapshots (`snapshotContainer()`, passed back to `start()`). Browser profiles, and so the sites a
  dog is signed in to, survive with the files. Limits Cloudflare states: a snapshot keeps files, not memory or running
  programs, so the desktop session starts fresh on wake; it restores only onto the image it was taken from, so an image
  update has to carry a dog's files across another way; it is kept 30 days from creation or the last restore; it is at
  most 20 GB.
- **Credentials:** never in the image. Sign-ins happen in the dog's own browser on that machine (the person takes over the
  noVNC view to type them); API keys a dog needs are injected by the Worker on egress, as Cloudflare's outbound handlers
  allow, so the container sees placeholders.
- **Cost:** billed by Cloudflare per active second of memory and CPU. A 1–2 vCPU dog computer awake two hours a day is a
  few dollars a month; asleep it uses no compute (what snapshot storage costs is not checked yet). The budget page
  (`docs/laterdog/cloudflare.md`) gets a row per dog.
- **Where it plugs in:** a new computer kind next to `vps` and `boat` (server driver + `Where <dog> works` option), so
  approvals, the Computer/Browser/Files tabs and the "This PC — not ready" reasoning all apply unchanged.

## Order of work

1. A single-dog prototype: image, Worker + Durable Object, exec/screenshot/input, noVNC view, sleep and wake from
   snapshots. In progress since 2026-10-08.
2. The computer kind in the app, with approvals and the Computer tab, behind a setting.
3. Many dogs: one Durable Object per dog id, a per-dog budget line, and an idle reaper.
4. Later: the coordinator dog itself moves into the cloud (roadmap item 2), so routines and packs keep working with every
   Mac closed — the Grok Bot shape, on infrastructure the operator owns.

This keeps the desktop light — the heavy machines live in the cloud only while a dog is using them.
