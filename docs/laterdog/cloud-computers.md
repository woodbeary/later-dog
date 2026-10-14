# Cloud computers for dogs

A dog that keeps working after the laptop closes needs a computer that is not the laptop. This page sets out the design
for a per-dog cloud computer on the operator's own Cloudflare account. Since 0.3.6 the app offers a free 30-minute trial
on later.dog's own service (`cloud.later.dog`); running them on your own account takes the deploy in
[deploy/laterdog/computers](../../deploy/laterdog/computers/README.md). Facts about Cloudflare are from Cloudflare's Containers and
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
- **Credentials:** never in the image. Sign-ins happen in the dog's own browser on that machine: the person fills a
  Secure Form that later.dog types into the page (below), or takes over the noVNC view for anything a form cannot do;
  API keys a dog needs are injected by the Worker on egress, as Cloudflare's outbound handlers allow, so the container
  sees placeholders.
- **Cost:** billed by Cloudflare per active second of memory and CPU. A 1–2 vCPU dog computer awake two hours a day is a
  few dollars a month; asleep it uses no compute (what snapshot storage costs is not checked yet). The budget page
  (`docs/laterdog/cloudflare.md`) gets a row per dog.
- **Where it plugs in:** a new computer kind next to `vps` (server driver + `Where <dog> works` option), so
  approvals, the Computer panel and the "This PC — not ready" reasoning all apply unchanged.

## The free trial's one computer, and deleting a dog

The free trial includes one cloud computer (the service answers a second with `trial_one_computer`). A dog's computer is named for the dog and this installation, so a computer whose dog no longer exists is an orphan that would hold that one slot. Two things release it, only while the trial is the computers service in use (never on a paid plan or the person's own service, where orphans stay in Settings for the person to delete):

- deleting a dog deletes its computer as before, and then sweeps any other orphaned trial computer of this installation (`releaseDeletedDogsComputers` in `server/computers.ts`, called from `deleteBotWithLifecycle`);
- if the next dog's create is refused with `trial_one_computer`, the same sweep runs once and the create is retried, so a computer orphaned by an older deletion, a restore or a failed cleanup no longer blocks the next dog.

A computer with a dog (any current dog or team computer owner) is never touched, and with no owner list registered nothing is released. `server/computers.test.ts` proves the sweep against a fake service that enforces the one-computer limit.

## Sign-ins with a Secure Form

Added 2026-10-12. A dog on its cloud computer (`box`) that reaches a sign-in page asks with `request_secure_form`: a
title, the site's host (for example `icloud.com`) and one to six fields, each text, email, password or code. The chat
shows a small card; the person clicks **Open**, fills the fields and chooses **Continue**. The values go to `POST
/api/bots/:botId/secure-forms/:formId/submit` and stay in the server's memory only (`server/laterdog/secure-form.ts`).
They are never written to the chat store, logs, tool results or the prompt that wakes the dog. later.dog then wakes the
dog, which calls `fill_secure_field` once per field with that field's position on the screen, and the server types the
value with one shell command on the computer. The command types nothing unless:

- the active window is the web browser, not a terminal or another app;
- the browser's address, read through the address bar (ctrl+L, ctrl+C), is `https://` on the form's host or one of its
  subdomains, after dropping any user name, port and trailing dot, so `example.com.evil.test`, `example.com@evil.test`
  and `evil.test/?next=example.com` are refused (hosts many sites share, such as `github.io` or `co.uk`, are refused
  when the form is made);
- the point is inside the window and below its top 100 px, so the click cannot land in the address bar;
- the same window still has focus after the click.

It then pastes the value through the clipboard, clears the clipboard, and presses Enter only when the dog asks. A field
can be typed at most three times. The values are wiped two minutes after the last field is typed, ten minutes after they
are sent, when a newer form replaces the card, or when later.dog restarts (a card still waiting then shows **Not
filled**). The dog's tool results say whether a field was typed and, if not, why; they never include the value or the
computer's output.

Limits, as of 2026-10-12:

- **Tested on fakes only.** The command has run only against fake `xdotool`, `xclip` and `xprop`
  (`server/laterdog/secure-form.test.ts`), including shell-injection and look-alike-host cases. It has not run on a live
  cloud computer, so the address-bar copy, clipboard clearing, `mousemove --sync` and window geometry under xfwm4 are
  unconfirmed there. Fixture success does not qualify a live computer.
- **A hostile page can fool the address check.** The address is read through keys a page can intercept, so a page built
  to fool the check can hand back a fake address. The check stops wrong tabs, wrong sites and look-alike hosts, not a
  page that attacks it. Reading the address from the browser itself needs a DevTools connection on the computer, which
  needs a computers redeploy (not done).
- **The dog's own computer holds the value briefly.** It is in the clipboard, and base64-encoded in a shell's command
  line, for a second or two. A dog running commands on its computer to watch for it could capture it; later.dog itself
  never hands it to the dog.
- **Typed text stays on the page.** Email, username and code fields show what was typed, so screenshots show them;
  password fields are masked by the page.
- **Main browser window only.** Popups, app windows and pages without an address bar are refused, and the dog falls back
  to `request_takeover`.
- **Desktop only.** The phone shows the card with "Open this chat on the host computer to fill this in." A live call
  says the form is waiting on screen and never asks for the values aloud.
- **Older computers.** A computer without `xclip` or `xprop` refuses to type.
- **Internationalised hosts.** A host written in Unicode may not match the address bar's form of it; the fill is
  refused.

## Order of work

1. A single-dog prototype: image, Worker + Durable Object, exec/screenshot/input, noVNC view, sleep and wake from
   snapshots. In progress since 2026-10-08.
2. The computer kind in the app, with approvals and the Computer panel, behind a setting.
3. Many dogs: one Durable Object per dog id, a per-dog budget line, and an idle reaper.
4. Later: the coordinator dog itself moves into the cloud (roadmap item 2), so routines and packs keep working with every
   Mac closed, on infrastructure the operator owns.

This keeps the desktop light — the heavy machines live in the cloud only while a dog is using them.
