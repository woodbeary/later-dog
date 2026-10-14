# later.dog cloud computers

Every dog gets its own Linux desktop on Cloudflare. The dog drives it over an API: shell commands, files, screenshots,
and `xdotool` for mouse and keyboard. The person opens a signed link to watch the screen live, and can take it over.
A computer nobody uses goes to sleep by itself: its disk is snapshotted and the container stops. An idle computer costs
nothing but its snapshot. Waking it restores the files.

## Live deployment

- API: `https://laterdog-computers.<subdomain>.workers.dev/v1`
- Worker `laterdog-computers`, version `ec1b0c67-ef33-4737-8ee4-4a2a2122cd9a` (deployed 2026-10-08).
- Image `laterdog-computers-dogcomputer-desktop@sha256:546522aba5ca2fe2ec91662f5d6abda2c18269986d30574aaeb452ed82ed11fa`.
- The key is in `~/.laterdog/computers-key` and the base URL in `~/.laterdog/computers.json` (both mode 600).
- later.dog's server uses these computers instead of Boat as soon as `~/.laterdog/computers.json` exists
  (`server/laterdog/cloud-computers.ts`). Delete that file to go back to Boat.

## Measured

Live runs on 2026-10-08, size `standard`: four runs of `pnpm run smoke`, one idle-policy run, two delete runs and one
run in a real browser. Times are from the client unless marked "inside": those come from the Durable Object's own log.

| What | Time |
| --- | --- |
| Create to `running` | 6.6 s, 6.7 s and 6.6 s in the last three smoke runs. POST answers in 1.2 to 1.4 s. Inside: ready 4.4 to 7.0 s after start in six of eight boots. |
| Create to `running`, slow boots | 18.6 s for the first boot after the deploy (POST took 16.4 s). Inside: 18.2 s and 15.1 s, two of eight boots. Probably a host fetching the image (not confirmed). |
| Sleep (snapshot, then stop) | 4.9 to 5.0 s (5.7 s once). Inside: the snapshot took 4.2 to 4.9 s for 1.6 MB of changes. |
| Wake to `running` (from the snapshot) | 5.6 to 5.8 s. POST answers in 1.3 to 1.6 s. Inside: ready 4.6 to 5.3 s after start. |
| exec round trip (`uname -a && whoami && echo $DISPLAY`) | 110 to 180 ms |
| File PUT / GET | about 100 ms / 130 to 350 ms |
| Screenshot (1280×800 JPEG, about 84 KB) | 140 to 270 ms |
| Viewer WebSocket to the VNC greeting | 0.3 to 0.5 s |

Those numbers are from before the readiness change below. `running` then meant the XFCE panel and wallpaper were on
screen. Now it means the screen answers (see Waking and readiness).

The idle run used a temporary deploy with `IDLE_SLEEP_MINUTES=1`. A viewer with a finished VNC handshake stayed open for
104 s, sending nothing, and the computer stayed awake. 68 s after the viewer closed, the computer snapshotted itself
(358 KB in 4.5 s) and went to sleep. The deploy was then put back to 15 minutes.

## How it works

```
later.dog server ──Bearer ldc_…──▶ Worker laterdog-computers ──RPC──▶ DogComputer Durable Object ──ctx.container──▶ desktop container
person's browser ──/desktop/<id>/<token>/──▶ Worker ──fetch──▶ DogComputer ──WebSocket──▶ websockify :6080 ─▶ x11vnc ─▶ Xvfb :0
```

- `src/index.ts`: the Worker. It routes the API and the desktop links. It also exports `ComputersApi`, the same API for
  other Workers on the account through a service binding (see Service binding).
- `src/computer.ts`: `DogComputer`, one Durable Object per computer. It starts the container from the image or from the
  latest snapshot, picks the instance size, keeps the computer's record, runs commands, bridges the viewer's WebSocket,
  and uses its alarm for readiness and the idle policy.
- `src/registry.ts`: `ComputerRegistry`, one Durable Object. It lists computers and enforces `MAX_COMPUTERS` and
  `Idempotency-Key` replays. Each computer's own object stays the truth.
- `src/trial.ts`, `src/trial-page.ts` and `src/trial-registry.ts`: free trials (see Free trials). `TrialRegistry` is
  one Durable Object, named `trials`. It starts trials, limits them per network and per day, keeps their minutes and
  deletes their computers when they expire. Each trial lists its computers in its own `ComputerRegistry`.
- `src/viewer.ts`: the viewer page. It loads noVNC from the static path `/novnc/<version>/` (see noVNC as static
  assets) and scales the screen to the window. The person can use the mouse and keyboard as soon as the screen appears.
- `src/ready.ts`: what "the screen answers" and "the desktop is drawn" mean, and the viewer's wait for a starting computer.
- `container/`: the image. Debian trixie (`node:24-trixie-slim`), Xvfb at 1280×800, XFCE (window manager, panel,
  desktop and settings daemon, started directly: no session manager), x11vnc on localhost, websockify and noVNC on
  port 6080, Chromium, `xdotool`, `scrot`, `xclip`, `git`, `gh`, Node 24. The user is `dog` (uid 1000) with
  passwordless `sudo`.

## API

Base URL `https://laterdog-computers.<your-subdomain>.workers.dev/v1`. Every request needs
`Authorization: Bearer ldc_…`, or a free-trial key `ldt_…` (see Free trials). The Worker stores only the key's SHA-256 (secret `COMPUTERS_KEY_SHA256`). It compares
digests in constant time. The API is for servers: a request with an `Origin` header is refused (403). So a browser can
never call it, even with a leaked key.

Errors are JSON `{ "error": { "code": "…", "message": "…" } }` with a matching status: 400 `invalid_*`, 401
`unauthorized`, 403 `browser_origin` / `trial_size`, 404 `not_found` / `file_not_found` / `no_trial`, 405
`method_not_allowed`, 409 `asleep` / `limit_reached` / `is_directory` / `trial_ended` / `trial_used_up`, 413
`too_large`, 502 `start_failed` / `snapshot_failed` / `screenshot_failed` / `container_error`, 503 `not_configured` /
`trials_off` / `trial_unavailable`.

A computer looks like:

```json
{ "id": "cmp_k3v9q2m7x4ab", "name": "Rex", "size": "standard", "state": "running", "desktopAvailable": true,
  "createdAt": "2026-10-08T19:02:11.412Z", "lastActiveAt": "2026-10-08T19:05:40.003Z",
  "snapshotAt": "2026-10-08T18:40:02.950Z" }
```

`state` is `starting`, `running`, `sleeping`, `stopping` or `error` (then `error` says why). `snapshotAt` appears once
the computer has slept. `desktopAvailable` is `true` once the desktop is drawn: a `running` computer whose desktop is
still drawing has it `false` (see Waking and readiness).

| Request | Answer |
| --- | --- |
| `POST /computers` `{ "name"?, "size"?: "small" \| "standard" \| "large" \| "xlarge" }`, optional `Idempotency-Key` header | 201 `{ computer }` in state `starting`. It answers once Cloudflare has placed the container (1 to 16 s measured). Sizes: `standard-1` (½ vCPU, 4 GiB, 8 GB disk), `standard-2` (1 vCPU, 6 GiB, 12 GB; the default), `standard-3` (2 vCPU, 8 GiB, 16 GB) and `standard-4` (4 vCPU, 12 GiB, 20 GB). The same key within 24 hours returns the same computer, with header `Idempotent-Replayed: true`. At `MAX_COMPUTERS`: 409 `limit_reached`. |
| `GET /computers` | `{ computers: [...] }` |
| `GET /computers/:id` | `{ computer }` or 404 |
| `PATCH /computers/:id` `{ "name" }` | `{ computer }` |
| `DELETE /computers/:id` | `{ deleted: true }`. Destroys the container and forgets the computer. |
| `POST /computers/:id/wake` | `{ computer }` in state `starting`. Boots from the latest snapshot, or from the image if it never slept. Poll `GET` until `running`. |
| `POST /computers/:id/sleep` | `{ computer }` in state `sleeping`. Snapshots the disk, then stops the container. Answers when done. |
| `POST /computers/:id/exec` `{ "command", "timeoutMs"? (default 120000, max 600000), "cwd"?, "env"? }` | `{ exitCode, stdout, stderr, timedOut }`. Runs `bash -lc command` as `dog` in `/home/dog` with `DISPLAY=:0`. Each stream keeps its first 1 MiB. On timeout the command and everything it started are killed (exit 124). 409 `asleep` unless `running`. Exec never wakes a computer. `env` is described below. |
| `GET /computers/:id/files?path=` | The file's bytes, 404 if missing, 413 over 16 MB. Relative paths start at `/home/dog`. |
| `PUT /computers/:id/files?path=` raw body | `{ ok: true }`. Up to 16 MB. Creates missing folders. New files and folders belong to `dog`. |
| `GET /computers/:id/screenshot` | `image/jpeg` of the whole screen, pointer included. |
| `POST /computers/:id/desktop` | `{ url, expiresAt }`: a viewer link valid for 2 hours. It is signed (HMAC-SHA256, secret `DESKTOP_SIGNING_KEY`) over the id, the expiry and the boot count, so it also dies when the computer sleeps. Anyone holding it can watch and take over: share it only with the person. Works while the computer is `starting` too: the page shows "Connecting…" and the screen connects as soon as it answers. 409 `asleep` unless `running` or `starting`. |

### MCP

`POST /mcp` is the same computers and decisions as nine MCP tools (`computer_list`, `computer_create`, `computer_wake`,
`computer_sleep`, `computer_screenshot`, `computer_action`, `computer_exec`, `computer_viewer_link`, `decide`): JSON-RPC 2.0 over
Streamable HTTP, one JSON answer per POST, no streaming. It takes the same bearer keys as `/v1/computers`, reaches the same
handlers (`src/mcp.ts` calls `listComputers`, `createComputer`, `computerRequest` and the decision code), and so keeps their
scoping and limits. `src/mcp-tools.ts` holds the tool definitions and the argument check, with no imports, so the desktop's
local MCP server reuses them. See [docs/laterdog/computer-tools.md](../../../docs/laterdog/computer-tools.md).

### Environment for one command

`env` is an object of names to string values, such as `{ "ANTHROPIC_API_KEY": "…" }`. It is laid over the base
environment (`DOG_ENV` in `src/computer.ts`) for that one command. Children it starts, including ones it detaches with
`setsid -f`, inherit it as usual in Linux (not seen live yet). The next command does not see it. The rules, each refused with 400 `invalid_env`:

- names match `^[A-Z_][A-Z0-9_]*$`;
- at most 32 entries;
- each value is a string of at most 16 KiB (16384 bytes of UTF-8), without NUL;
- `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `DISPLAY`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` cannot be
  set. `LANG`, `TZ` and `NO_AT_BRIDGE` can.

The Worker never stores the values, never logs them, and never puts them in an error. Error messages do not repeat
names that were refused either, only the reserved list. If the container refuses the command, each value is replaced
with `[redacted]` in the error and the log line, both as written and JSON-escaped. A command that prints a value (`env`,
`echo $ANTHROPIC_API_KEY`) returns it in `stdout` like any other output, and processes inside the computer can read it
from `/proc`.

### Service binding

Other Workers on the same Cloudflare account can call the API through a service binding to the named entrypoint
`ComputersApi`, so no API key moves between Workers. The caller declares:

```jsonc
"services": [{ "binding": "COMPUTERS", "service": "laterdog-computers", "entrypoint": "ComputersApi" }]
```

and calls `env.COMPUTERS.fetch("https://laterdog-computers.<subdomain>.workers.dev/v1/computers", …)`. It serves the
same `/v1/...` API as the public route and acts as the owner. It skips the bearer key check, and ignores any
`Authorization` header (a trial key is not a trial there). It still refuses a request with an `Origin` header (403
`browser_origin`). `/healthz` answers; any other path outside `/v1/` answers 404 `not_found`, so desktop links and the
trial page are served only on the public route. Desktop links are signed for the request URL's origin, so use the
public base URL as above, or the link will point at the wrong host. `wrangler.jsonc` needs no change for the
entrypoint: wrangler reads `exports` entries for entrypoints only to configure caching, and a binding names any
exported `WorkerEntrypoint` class (read in wrangler 4.149's code, not seen in a deploy).

```sh
API=https://laterdog-computers.<subdomain>.workers.dev/v1
AUTH="Authorization: Bearer $(cat ~/.laterdog/computers-key)"
id=$(curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d '{"name":"Rex"}' "$API/computers" | jq -r .computer.id)
until [ "$(curl -s -H "$AUTH" "$API/computers/$id" | jq -r .computer.state)" = running ]; do sleep 2; done
curl -s -X POST -H "$AUTH" -d '{"command":"setsid -f chromium https://example.com >/dev/null 2>&1"}' "$API/computers/$id/exec"
curl -s -H "$AUTH" "$API/computers/$id/screenshot" > screen.jpg
curl -s -X POST -H "$AUTH" "$API/computers/$id/desktop" | jq -r .url
```

### Driving the desktop

Commands see the desktop's display and session bus, so ordinary X tools work: `xdotool mousemove 640 400 click 1`,
`xdotool type 'hello'`, `xdotool key ctrl+l`, `xdotool getactivewindow getwindowname`, `xclip -selection clipboard -o`.
Start long-running apps detached, with their output redirected: `setsid -f chromium https://example.com >/dev/null 2>&1`.
A background app that keeps the command's output open is killed when the command's timeout ends.

## Waking and readiness

A computer goes `starting` → `running` → `desktopAvailable: true`:

1. **`starting`**: the container was placed. The Durable Object's alarm polls every 250 ms. A poll opens a WebSocket to
   websockify on port 6080 and waits for the RFB banner (`RFB 003.008`). That proves the display, x11vnc and websockify
   are all up, and it costs one short connection instead of a `bash` exec.
2. **`running`**: the screen answers. A viewer can connect and the API accepts commands. `desktopAvailable` is `false`.
3. **`desktopAvailable: true`**: the desktop is drawn. `src/ready.ts` (`DESKTOP_SCRIPT`) runs one short command as `dog`
   every 250 ms: the panel and desktop windows are visible, the panel windows hold pixels, and the middle of the
   screen is not a flat colour (a crop through `scrot` is larger than a threshold). A window that is mapped but not yet
   painted shows a black strip, which is what the old check (windows only) let through. If the windows are up but never
   paint, it gives up after 3 seconds; if they never appear (a dog changed the panel), after 30 seconds from `running`.
   Both are logged.

What waits for the desktop: `computer_wake` (MCP) keeps polling until `desktopAvailable` is true (30 s, then
`ready: false`), and a screenshot, over the API or MCP, waits up to the same 30 s so a dog never sees a half-painted
screen. Commands (`exec`), files and the viewer do not wait: shell work does not need the desktop, and the viewer is
the person's own view of it. The API list (`GET /computers`) comes from the registry and does not carry
`desktopAvailable`; read the computer itself.

A desktop link can be made while the computer is `starting`. The viewer page loads (it shows "Connecting…"), and the
WebSocket upgrade is held, retrying every 250 ms for up to 20 s, until the screen answers, instead of failing with 409.

Measured locally on 2026-10-14 (Colima VM on an M-series Mac, the container limited to 1 and to 0.5 CPU, `docker run`
to each step, medians of 7 boots with a warm image, milliseconds from the container starting). Cloudflare's `standard-1`
is ½ vCPU and `standard-2` is 1 vCPU, but this is not their hardware or their image pull: see Limitations.

| Step | before, 1 CPU | after, 1 CPU | before, ½ CPU | after, ½ CPU |
| --- | --- | --- | --- | --- |
| websockify answers HTTP | 1732 | 362 | 2336 | 663 |
| First RFB banner through the WebSocket (`running`) | 2403 | 1289 | 3620 | 2077 |
| Window manager up | 2648 | 1941 | 3465 | 3650 |
| Panel window mapped | 3248 | 1953 | 4431 | 3691 |
| Panel painted (`desktopAvailable`) | 4343 | 2028 | 5829 | 4685 |

Before, `running` meant the panel window was mapped (3248 ms at 1 CPU), but its content was painted 1.1 s later, so a
viewer that connected at once saw a black strip. The two changes that matter: websockify no longer imports numpy
(`container/laterdog-websockify`; its answer drops from 1.7 s to 0.36 s), and the shell starts the window manager,
panel and desktop directly instead of through `xfce4-session`, with the panel, desktop and settings daemon at `nice 10`
so the VNC path gets the CPU first. The rest is XFCE itself: at 1 CPU the window manager, panel and desktop cost about
0.9 s of CPU between them.

The Worker side of the wake path did three things. The poll went from 1000 ms to 250 ms, so a boot is noticed on
average 375 ms sooner. The poll is one WebSocket instead of a `bash` exec plus an HTTP fetch (about 150 ms of the
README's measured exec round trip per poll). And `running` no longer waits for the painted desktop. Modelled from the
timeline above, not measured through the Worker: at 1 CPU the old check said `running` at the first 1 s tick after the
panel window appeared, about 4.0 to 4.3 s after start; the new one says `running` at about 1.3 + 0.25 s, and
`desktopAvailable` at about 2.0 + 0.25 s.

## noVNC as static assets

The viewer page imports noVNC from `/novnc/1.6.0/core/rfb.js`, served by Workers Static Assets from
`third_party/novnc/public` (`assets.directory` in `wrangler.jsonc`), not through the Durable Object and the container.
The path has no token and the version is in it, so `public/_headers` gives every file `Cache-Control: public,
max-age=31536000, immutable`, and the page lists all 52 modules in `<link rel="modulepreload">` so the five levels of
imports load in one round trip. The files are Debian's noVNC 1.6.0, unmodified, with their licence notices;
`test/novnc.test.ts` checks that the list in `src/novnc.ts` is exactly the import graph of `rfb.js`. The container still
serves its own copy on port 6080 for `http://localhost:6080/vnc.html` in local tests. The old route
`/desktop/<id>/<token>/core/...` is gone.

## The desktop

A computer starts with a normal XFCE desktop: a panel at the top (Applications menu, window list, tray, clock) and a
dock at the bottom, always visible, with three launchers: **Browser** (Chromium, first, with its own icon and the name
"Browser"), **File Manager** and **Terminal**. The terminal, files and the Applications menu are all there.

Nothing in the desktop can end the session or take the screen away. Each of these is a choice, listed so it can be
undone:

- No session manager. `xfce4-session` is not installed, so there is no Log Out, Shut Down, Restart, Suspend, Hibernate
  or Lock to reach: `xfce4-session-logout` and `xflock4` do not exist. The window manager, settings daemon, panel and
  desktop are started by `container/start-desktop.sh` and restarted if they exit.
- The panel's Actions menu (log out, shut down) is not on the panel. The stock dock's Show Desktop, application finder
  and directory menu are not on the dock; the workspace pager is not on the top panel (there is one workspace).
- The keyboard shortcuts Ctrl+Alt+Delete (log out), Ctrl+Alt+L (lock) and Super+P and the display key (display
  settings) are removed (`container/xfce-system/xfce4-keyboard-shortcuts.xml`, the stock file minus those lines).
- Display Settings is not in the Settings menu or the Settings Manager (`xfce-display-settings.desktop` is deleted),
  because changing the resolution of the virtual screen can break the viewer, which expects 1280×800. There is no screensaver, lock or power manager
  package. Xvfb runs with `-s 0 -dpms` so the screen never blanks.
- The x11vnc launcher is not in the menu (starting a second VNC server would not help anyone).
- Not restricted: the terminal, `sudo`, the file manager, the other settings (appearance, keyboard, mouse, panel, window
  manager and its tweaks, the settings editor), and Chromium. Window Manager Tweaks has a compositor switch; xfwm4 is
  started with compositing off and nothing stops someone turning it on.

The dogs' tools do not depend on any of it: `exec` runs `bash -lc` as `dog` and talks to the X server directly (`xdotool`,
`scrot`, `xclip`), and the readiness and screenshot commands need only the panel, the desktop and Xvfb.

## What survives sleep and wake

Sleep takes a snapshot of the disk, not of memory; wake starts the container from it, so the desktop starts fresh.
Checked locally with `docker commit` of a running computer, which is the same kind of disk-only snapshot (nothing was
closed first), then a new container from it:

- Files in `/home/dog` and everywhere else on the disk survive.
- Open windows do not: Chromium, the terminal and the file manager are all closed after a wake, and nothing reopens
  them. The Browser icon opens Chromium with a new tab, not the old tabs.
- Chromium's profile survives (`~/.config/chromium`: cookies, logins, history, preferences, and the session files).
  Started with `chromium --restore-last-session`, the two tabs that were open came back, and a page saw both the
  persistent cookie and the session cookie. Plain `chromium` does not restore them.
- Chromium writes cookies to disk about every 30 seconds. A cookie set 8 seconds before the snapshot was not in the
  profile after the wake; one set 40 seconds before was. So a login made in the last half minute before sleeping is
  lost, because the snapshot does not ask Chromium to flush first.

To make "remembers where you left off" true for the browser, two small changes would do it, and neither is in this
change: a Chromium policy `RestoreOnStartup` = 1 in `/etc/chromium/policies/managed/` so the Browser icon (and any
`chromium` a dog starts) restores the last session; and, in `DogComputer.sleep()`, a graceful `kill -TERM` of Chromium
and a short wait before `sync` so its cookies and session are flushed. Reopening a terminal or the file manager at the
same place would need an XFCE session manager saving its session, which this desktop deliberately does not have.

## The idle policy (cost is the point)

Activity is any API call that uses the computer (exec, files, screenshot, desktop link, wake) and any traffic from an open
viewer. Reading a computer's state with `GET` is not activity. The `DogComputer` alarm checks at least every five minutes:

- An open viewer or a running request keeps the computer awake.
- Otherwise it sleeps (snapshot, then stop) after `IDLE_SLEEP_MINUTES` (default 15) without activity.
- Whatever happens, it sleeps after `MAX_AWAKE_HOURS` (default 8) awake, even with a viewer open. This catches a forgotten
  tab.
- The platform's own inactivity timeout is the idle time plus 45 minutes. It is a backstop in case the alarm cannot run.
  That stop takes no snapshot.

`MAX_COMPUTERS` (default 10) caps how many computers exist at once, awake or asleep. All three are `vars` in
`wrangler.jsonc`. The rules are unit tested in `test/idle.test.ts`. The first two were also seen working live (see
Measured).

## Free trials

Someone without a deployment of their own can try a computer for free: `TRIAL_MINUTES` (default 30) minutes awake,
used within `TRIAL_DAYS` (default 7) days. No card and no account. Trials stay off until `TRIALS_ENABLED` is `"true"`
and the Turnstile keys and `TRIAL_NETWORK_KEY` are set (see Turning on free trials).

How a trial starts:

1. later.dog makes a trial key, `ldt_` and 43 random base64url characters, and keeps it. It opens
   `/trial?claim=<the key's SHA-256, lowercase hex>` in the person's browser. Only the digest passes through the
   browser, so a copied link does not give anyone the trial.
2. The page shows a Cloudflare Turnstile check. Once it passes, the page posts the form back to `/trial` by itself
   (**Start free trial** is the same post, for a check that needs a second try). The answer page says the trial has
   started and opens `laterdog://trial`, which brings later.dog to the front; the app then moves the dog to the free
   cloud computer and starts it.
3. The Worker checks, in order: the form came from its own page (`Origin`), it is a small URL-encoded form, the claim is
   well formed, the country is allowed (`TRIAL_COUNTRIES`; empty means everywhere), the network can be identified, and
   Turnstile's siteverify accepts the token for this hostname, the action `trial` and this claim. A token solved for
   another claim is refused.
4. `TrialRegistry` starts the trial and the page says so. later.dog then calls the API with the key as its bearer.
   Sending the form again is harmless: the page answers with the minutes left.

What a trial may do:

- One computer at a time, size `standard`. Trial computers do not count toward `MAX_COMPUTERS`.
- A trial key sees only its own trial's computers. Anything else answers 404.
- Minutes count while a trial computer is starting, awake or going to sleep. Asleep costs nothing.
- A trial computer sleeps after `TRIAL_IDLE_SLEEP_MINUTES` (default 5) without activity, and as soon as the minutes run
  out, even with a viewer open. Waking needs at least a minute left. If the snapshot fails when the minutes run out, the
  computer tries again every five minutes. Ten minutes after the end it is stopped without a snapshot and shows `error`.
- When the trial expires, its computers are deleted. If a deletion fails, `TrialRegistry` tries again an hour later.

Who gets one:

- One trial per network per `TRIAL_DAYS`: per IPv4 address, or per IPv6 /64. The Worker keeps an HMAC-SHA256 of the
  network (secret `TRIAL_NETWORK_KEY`), never the address, and forgets it when the window ends.
- At most `TRIALS_PER_DAY` (default 20) new trials per UTC day for the whole deployment.

| Request | Answer |
| --- | --- |
| `GET /v1/trials`, no key | `{ offered, minutes, days }`. Like the rest of the API, refused with an `Origin` header. |
| `GET /v1/trial` | `{ trial: { state, minutes, minutesLeft, expiresAt } }`. `state` is `active`, or `used_up` with under a minute left. 401 once the trial has ended, or before it starts. 404 `no_trial` for the owner's key. |
| `DELETE /v1/trial` | `{ ended: true }`. Deletes the trial's computers and ends it now. Its network stays used until the window ends. |
| `POST /v1/trials/grant`, owner's key | Body `{ "claim": "<64 hex>" }`, the claim from a trial link. Starts that trial without the browser check and without using a network's trial or the day's count, for gifting a trial or testing the whole flow. 201 with `{ trial }`, 200 when that claim already has one, 403 `owner_only` for a trial key. |
| `POST /v1/complete`, a trial or plan key | Typing suggestions. Body `{ prefix, dog?, messages?: [{ role: "person" \| "dog", text }], phrasing?: string[] }`: the text typed so far, the dog's name, at most 6 recent messages (400 characters each) and at most 3 of the person's own phrases. It answers `{ completion, model }`, where `completion` is the next few words (empty when the model has nothing to add). It runs `TYPING_AI_MODEL` (default `@cf/meta/llama-3.2-3b-instruct`) on Workers AI through the AI Gateway with 20 output tokens and temperature 0.2, logs and stores no text, and counts one `completions` use per call against `COMPLETIONS_PER_DAY` (4,000) per installation. 401 without a live key, 403 with an `Origin`, 413 over 16 KB, 422 for a bad body, 429 over the day's allowance, 502 when the model does not answer, 503 without the `AI` binding. |
| `GET /trial?claim=` | The page with the check (HTML). |
| `POST /trial` | The form. It answers with a page: 200 when the trial started, else 400, 403, 413, 415, 429 (the network had a trial, or the day's trials are taken), 502 (siteverify could not be reached) or 503 (trials are off). |

The kill switch is `TRIALS_ENABLED`. Set it to `"false"` and run `pnpm run deploy:worker`. The page then answers 503, and
creating or waking a trial computer answers 503 `trials_off`. Trial computers already awake keep running until their
minutes or their idle time run out, then sleep. A trial can still be read, put to sleep and ended. The owner's
computers are not affected.

Cost: each day at most `TRIALS_PER_DAY` trials start, each with `TRIAL_MINUTES`. With the defaults that is 10 awake
hours of `standard` a day on average. That is about 57 cents (CPU idle) to $1.30 (CPU flat out) a day, so at most about
$40 a month, plus snapshot storage, which has no published price. Several days' trials can spend their minutes on the
same day, and a computer whose snapshot keeps failing can run 10 minutes over.

### In the app

Settings shows the trial under Computer, Cloud computers. later.dog asks `GET /v1/trials` only while no cloud computers
are set up: no `computers.json`, no `LATERDOG_COMPUTERS_API` and no Boat key. It asks the service in
`DEFAULT_TRIAL_API` (`server/laterdog/cloud-trial.ts`), which is `https://cloud.later.dog/v1` since 0.3.6: this Worker's
custom domain on later.dog's own deployment. `LATERDOG_TRIAL_API` overrides it, for testing, and `off` switches the
trial off. Tests and isolated fixtures run with it off.

- **Start free trial** writes the key to `~/.laterdog/computers-trial-key` and the trial's state to
  `~/.laterdog/computers-trial.json`, both mode 600, and opens the page. While Settings is open, it checks every 3
  seconds until the trial starts, then every 30 seconds. A trial started with Settings closed is picked up the next
  time Settings opens.
- Once `GET /v1/trial` answers, the trial is this installation's cloud computers until it ends. `computers.json` and
  `LATERDOG_COMPUTERS_API` come first whenever they are set.
- **End trial** asks first, then calls `DELETE /v1/trial`. A 401 means the trial has already ended. Either way it is
  marked ended and the key file is deleted. The app offers no second trial. Deleting both files offers it again, but
  the network limit still applies.
- A trial computer that answers `trial_used_up`, `trial_ended` or `trials_off` stops waking at once.
- later.dog handles trial requests one at a time, so a check still waiting for the service finishes before a Cancel or
  **End trial** runs.

## Costs

Containers bill only while running, per 10 ms, on Workers Paid. Cloudflare's rates (pricing page updated 2026-10-05):

- Memory: $0.0000025 per GiB-second of the instance's size, while running.
- Disk: $0.00000007 per GB-second of the instance's size, while running.
- CPU: $0.000020 per vCPU-second, only for CPU actually used.
- Asleep: no container charges. Snapshot storage has no published price, so it is not included here.
- Workers Paid includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk a month.

| Size | Awake, CPU idle | Awake, CPU flat out |
| --- | --- | --- |
| small (`standard-1`: ½ vCPU, 4 GiB, 8 GB) | about $0.038 per hour | about $0.074 per hour |
| standard (`standard-2`: 1 vCPU, 6 GiB, 12 GB) | about $0.057 per hour | about $0.13 per hour |
| large (`standard-3`: 2 vCPU, 8 GiB, 16 GB) | about $0.076 per hour | about $0.22 per hour |
| xlarge (`standard-4`: 4 vCPU, 12 GiB, 20 GB) | about $0.113 per hour | about $0.40 per hour |

An idle XFCE desktop uses little CPU. So a standard computer costs about 6 cents per awake hour and nothing while asleep.
The 8-hour backstop caps a forgotten computer at about 45 cents. Worker requests and Durable Object time are billed
separately and are small next to the container.

## Deploy to your own Cloudflare account

You need a Workers Paid account with Containers, a workers.dev subdomain, `wrangler login`, a running Docker engine,
Node 24 and pnpm. The image is built locally for linux/amd64. On Apple silicon that build is emulated and takes several
minutes the first time.

```sh
cd deploy/laterdog/computers
pnpm run setup
```

`pnpm run setup` runs `scripts/deploy.sh`. It:

1. installs this package on its own (`--ignore-workspace`);
2. runs `wrangler deploy`, which builds and pushes the image and deploys the Worker;
3. creates the API key once, in `~/.laterdog/computers-key` (mode 600), and sets the secret `COMPUTERS_KEY_SHA256` to its
   SHA-256 (the key never leaves the machine);
4. sets `DESKTOP_SIGNING_KEY` to a random value if the Worker has none;
5. waits until the Worker accepts the key, then writes `~/.laterdog/computers.json` (mode 600).

Secrets go to wrangler on stdin and are never printed. Run it again to redeploy; it keeps the key. On 2026-10-08 it took
2 minutes 29 seconds with Docker's build cache warm.

For Worker-only changes, `pnpm run deploy:worker` (`--containers-rollout=none`) redeploys without building the image.
It keeps the image the last deploy prepared. It took 7 seconds.

### Turning on free trials

Trials stay off until all of this is done. Nothing here prints a secret.

1. In the Cloudflare dashboard, open **Turnstile** and choose **Add widget**. Use the hostname
   `laterdog-computers.<subdomain>.workers.dev` and the mode **Managed**. Put its site key, which is public, in
   `TURNSTILE_SITE_KEY` in `wrangler.jsonc`.
2. Set the two secrets. Paste the widget's secret key when wrangler asks for it:

   ```sh
   pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
   openssl rand -base64 48 | tr -d '\n' | pnpm exec wrangler secret put TRIAL_NETWORK_KEY
   ```

   Changing `TRIAL_NETWORK_KEY` later forgets which networks have had a trial.
3. To limit countries, set `TRIAL_COUNTRIES` to two-letter codes, such as `"US,CA"`. A request whose country is not
   known is then refused.
4. Set `TRIALS_ENABLED` to `"true"` and run `pnpm run deploy:worker`.
5. `curl -s https://laterdog-computers.<subdomain>.workers.dev/v1/trials` should answer `{"offered":true,...}`.
6. To offer trials from your own fork of the app, set `DEFAULT_TRIAL_API` in `server/laterdog/cloud-trial.ts` to your
   service, `https://<your domain>/v1`, change the test that names it, and release. To try it first, start later.dog
   with `LATERDOG_TRIAL_API` set to that address.

`wrangler.jsonc` is later.dog's own deployment: it serves `cloud.later.dog` as a custom domain beside its `workers.dev`
address, with trials on and later.dog's public Turnstile site key. For your own deployment, point `routes` at a domain
on your account (or remove it) and set your own site key.

`TrialRegistry` is declared in `exports` like the other classes. Wrangler 4.149 treats `exports` as the Durable Object
declaration and refuses `migrations` alongside it, so no migration is written. That was read in wrangler's code, not
seen in a deploy.

Cloudflare limits image storage to 50 GB per account. List images with `wrangler containers images list` and remove old
ones with `wrangler containers images delete <image:tag>`.

## Checks

- `pnpm test`: unit tests for the pure logic. API key check, desktop link signing, ids, routing, input validation,
  output capture, the idle policy and the free-trial rules. `test/exec-env.test.ts` covers exec's `env` (the rules,
  the merge, and that values stay out of the record, the logs and error bodies) and the `xlarge` size;
  `test/entrypoint.test.ts` covers the `ComputersApi` entrypoint and that the public route still needs the key.
  `test/ready.test.ts` and `test/wake-readiness.test.ts` cover the screen answering, the desktop being drawn (and the two
  grace periods), screenshots waiting for it, and a desktop link while starting; `test/novnc.test.ts` checks the vendored
  noVNC against the import graph.
  `test/trial-flow.test.ts`, `test/trial-registry.test.ts` and those two also run the Worker's own request handling and Durable Object classes against in-memory stand-ins (`test/fakes.ts`:
  SQLite from `node:sqlite`, a fake container and a clock that fires alarms). The stand-ins are not Cloudflare, so
  passing them says nothing about the live platform.
- `pnpm run check`: `wrangler types` and `tsc --noEmit`.
- `pnpm exec oxlint --deny-warnings deploy/laterdog/computers`, from the repository root.
- `pnpm run dry-run`: `wrangler deploy --dry-run`. This builds the image too.
- Local image smoke test (native arch): `docker build -t laterdog-computer:dev container && docker run --rm -p 6080:6080 laterdog-computer:dev`,
  then open http://localhost:6080/vnc.html. Chromium shows a "--no-sandbox" bar there when the Docker engine refuses
  user namespaces (`container/chromium-flags` adds the flag only then); Cloudflare allows them.
- `pnpm run smoke`: `scripts/smoke.mjs` against the deployed Worker, 34 checks. Auth; create and boot; exec as `dog` on
  `:0`; files; Chromium; screenshot; the viewer page and noVNC through the signed path; the raw WebSocket upgrade (HTTP
  101, then the `RFB 003.008` greeting as a binary frame, then a round trip to the VNC server); a forged link; exec
  timeout; sleep; wake; the file survives; the old link dies; the desktop is drawn again; delete. It reads the key from
  `~/.laterdog/computers-key` and never prints it. Screenshots go to `--out <dir>`.

## Verified live, and not

Seen working on 2026-10-08:

- everything `pnpm run smoke` checks;
- the idle sleep and the open-viewer rule, with a 1-minute idle time;
- in a real browser: the viewer showing the live desktop; **Take over** (a click opened a terminal, and typed keys
  created a file the API then found); **Hand back** (clicks stopped reaching the desktop);
- deleting a computer with a viewer open: the viewer is closed (code 4002) and told the link ended. Status and `GET`
  requests during the delete get 200 or 404, never an error.

Not seen live yet: the 8-hour `MAX_AWAKE_HOURS` backstop, the platform's inactivity-timeout backstop, the 30-day snapshot
expiry, recovery after Cloudflare restarts a host, the `small`, `large` and `xlarge` sizes, the `MAX_COMPUTERS` cap, renaming
(`PATCH`), and the list endpoint with computers in it.

Also not seen live yet, added after the last deploy and only unit tested against the stand-ins:

- `env` on exec. Not verified: that Cloudflare's `exec()` sets the values on the process the way it sets `DOG_ENV`, that
  a child detached with `setsid -f` inherits them (it does in plain Linux, and nothing in the command path clears the
  environment: `timeout` and `bash -lc` keep it, and Debian's default login files, which the Dockerfile does not
  replace, only set `PATH` and the like; the files in a built image were not inspected), and that Cloudflare's
  own logs (Workers Logs, container observability, the runtime) never record exec options.
- The `xlarge` size (`standard-4`). Whether this account's Containers limits allow it was not checked.
- The `ComputersApi` entrypoint and a service binding to it.

Free trials have not been deployed or seen live. Not verified: the Turnstile widget and siteverify with real keys
(Cloudflare's test keys cannot pass the hostname, action and claim checks), `cf-connecting-ip` and the country on real
requests, the new `TrialRegistry` class deploying without a migration, `TrialRegistry` waiting on a computer that
charges the trial back while it waits, and what the snapshots of trial computers cost.

## Limitations

- It runs on public-beta Cloudflare APIs: the `durable_object` scheduling policy, `ctx.container.exec` and snapshots.
  They may change.
- A snapshot holds the disk, not memory. After a wake the desktop starts fresh. Apps that were open are closed. Files
  are kept.
- A snapshot is tied to the image it was taken from. A new image only affects computers created afterwards. Existing
  computers keep restoring their own snapshots. There is no way to move a computer to a new image.
- A snapshot expires 30 days after it was taken or last restored. A computer asleep longer than that cannot be restored.
- A snapshot can be at most 20 GB.
- The Worker API cannot list or delete snapshots. Deleting a computer forgets its snapshot, which expires on its own.
- If the platform stops a container without our snapshot (a host restart, the inactivity backstop), changes since the
  last sleep are lost. The computer shows `error` until woken.
- No Docker inside a computer: containers are not privileged.
- The `dog` user is not a security boundary. In `durable_object` containers every process has root's capabilities. The
  boundary is the VM each computer runs in.
- Chromium keeps its own sandbox on Cloudflare (user namespaces work there). Where they are refused, it runs without it
  (`container/chromium-flags`).
- A desktop link gives full control until it expires or the computer sleeps. An open viewer keeps the computer awake,
  up to `MAX_AWAKE_HOURS`.
- Some boots are slower: 15 to 18 s instead of about 6 s, in two of eight boots. The likely cause is a host fetching
  the image; that is not confirmed. The image is 526 MB compressed (539 MB before the desktop change; arm64, as built
  locally; the amd64 image Cloudflare runs was not built), and its pull is not something the startup script can change.
- The timings in Waking and readiness are from a local Docker VM, not Cloudflare. How long the platform takes to place
  and pull is outside them. Not seen live: the 250 ms poll, `desktopAvailable`, the held WebSocket upgrade, the static
  assets and their cache headers, and the new image's dock.
- Free trials are limited per network, not per person. Everyone behind one IPv4 address (an office, a campus, a
  carrier-grade NAT) shares one trial per window. Someone with many networks (VPNs, proxies, IPv6 ranges) can start
  more; Turnstile and `TRIALS_PER_DAY` bound that. Whoever takes a day's trials leaves none for others that day.
- A trial computer has the same internet access as any other, so someone could misuse its minutes (spam, scanning).
  Nothing inspects the traffic.
- Any Worker on the account with a service binding to `ComputersApi` has the owner's full access, without a key.
- An ended trial frees its key: the same key can start a new trial from another network, as a new key could.
- The trial page is in English only.
- The screen is fixed at 1280×800. No audio. No clipboard or file transfer in the viewer: use the API.
- Files move 16 MB at a time. Command output keeps 1 MiB per stream.
- Commands get the environment in `src/computer.ts` (`DOG_ENV`) plus `PATH`, not the image's other variables, plus the
  request's own `env` for that command.
- When a viewer's connection to the desktop ends, the runtime sometimes logs an uncaught `Network connection lost` on
  the Durable Object (twice in the viewer sessions we logged). Nothing failed with it: the request still succeeded, and
  the computer still went to sleep normally. The cause is not known.
