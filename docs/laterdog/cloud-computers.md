# Cloud computers for dogs

A dog that keeps working after the laptop closes needs a computer that is not the laptop. This page sets out the design
for a per-dog cloud computer on the operator's own Cloudflare account. Cloud computers are coming soon: they are not part
of the 0.3.3 release, and the app shows them as "Coming soon". Facts about Cloudflare are from Cloudflare's Containers and
Sandbox documentation, read 2026-10-06; its scheduling-policy, snapshot and limits pages were read 2026-10-08. The design
below is direction b of the roadmap. A prototype service, a one-command deploy and measured timings are in
[deploy/laterdog/computers](../../deploy/laterdog/computers/README.md).

Two ideas shape it. State lives off the machine, so a machine can be thrown away and rebuilt; later.dog's supervisor
already does this with R2. And the machine sleeps when idle and wakes on demand, which keeps a per-dog computer
affordable.

## Design: a dog's computer on Cloudflare

One Durable Object and one container per dog that asks for a cloud computer, on the operator's own Cloudflare account,
built from the same pieces the supervisor already proved.

- **Image:** Debian with Xvfb + a small window manager, Chromium, the Cua driver the VPS computer already pins
  (`server/container-computer.ts`), and noVNC for the live view.
- **Scheduling:** the Containers `durable_object` scheduling policy (public beta). Each dog's Durable Object starts its own
  container and picks the image and instance size when it does; the policy needs the Durable Object to use SQLite storage.
- **Control:** a Worker in front of each dog's Durable Object, the way `deploy/laterdog/cloudflare` fronts the supervisor:
  bearer-checked HTTPS for exec / screenshot / input, and a
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
- **Where it plugs in:** a new computer kind next to `vps` (server driver + `Where <dog> works` option), so
  approvals, the Computer panel and the "This PC — not ready" reasoning all apply unchanged.

## Order of work

1. A single-dog prototype: image, Worker + Durable Object, exec/screenshot/input, noVNC view, sleep and wake from
   snapshots. In progress since 2026-10-08.
2. The computer kind in the app, with approvals and the Computer panel, behind a setting.
3. Many dogs: one Durable Object per dog id, a per-dog budget line, and an idle reaper.
4. Later: the coordinator dog itself moves into the cloud (roadmap item 2), so routines and packs keep working with every
   Mac closed, on infrastructure the operator owns.

This keeps the desktop light — the heavy machines live in the cloud only while a dog is using them.
