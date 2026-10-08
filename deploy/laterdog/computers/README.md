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

`running` means the desktop is drawn: the XFCE panel and wallpaper are on screen. The first smoke run (18.6 s) was
measured before readiness waited for that, which adds about a second.

The idle run used a temporary deploy with `IDLE_SLEEP_MINUTES=1`. A viewer with a finished VNC handshake stayed open for
104 s, sending nothing, and the computer stayed awake. 68 s after the viewer closed, the computer snapshotted itself
(358 KB in 4.5 s) and went to sleep. The deploy was then put back to 15 minutes.

## How it works

```
later.dog server ──Bearer ldc_…──▶ Worker laterdog-computers ──RPC──▶ DogComputer Durable Object ──ctx.container──▶ desktop container
person's browser ──/desktop/<id>/<token>/──▶ Worker ──fetch──▶ DogComputer ──WebSocket──▶ websockify :6080 ─▶ x11vnc ─▶ Xvfb :0
```

- `src/index.ts`: the Worker. It routes the API and the desktop links.
- `src/computer.ts`: `DogComputer`, one Durable Object per computer. It starts the container from the image or from the
  latest snapshot, picks the instance size, keeps the computer's record, runs commands, bridges the viewer's WebSocket,
  and uses its alarm for readiness and the idle policy.
- `src/registry.ts`: `ComputerRegistry`, one Durable Object. It lists computers and enforces `MAX_COMPUTERS` and
  `Idempotency-Key` replays. Each computer's own object stays the truth.
- `src/viewer.ts`: the viewer page. It loads noVNC from the same signed path and scales the screen to the window. The
  person watches by default. **Take over** gives them the mouse and keyboard. **Hand back** returns control to the dog.
- `container/`: the image. Debian trixie (`node:24-trixie-slim`), Xvfb at 1280×800, XFCE, x11vnc on localhost,
  websockify and noVNC on port 6080, Chromium, `xdotool`, `scrot`, `xclip`, `git`, `gh`, Node 24. The user is `dog`
  (uid 1000) with passwordless `sudo`.

## API

Base URL `https://laterdog-computers.<your-subdomain>.workers.dev/v1`. Every request needs
`Authorization: Bearer ldc_…`. The Worker stores only the key's SHA-256 (secret `COMPUTERS_KEY_SHA256`). It compares
digests in constant time. The API is for servers: a request with an `Origin` header is refused (403). So a browser can
never call it, even with a leaked key.

Errors are JSON `{ "error": { "code": "…", "message": "…" } }` with a matching status: 400 `invalid_*`, 401
`unauthorized`, 403 `browser_origin`, 404 `not_found` / `file_not_found`, 405 `method_not_allowed`, 409 `asleep` /
`limit_reached` / `is_directory`, 413 `too_large`, 502 `start_failed` / `snapshot_failed` / `screenshot_failed` /
`container_error`, 503 `not_configured`.

A computer looks like:

```json
{ "id": "cmp_k3v9q2m7x4ab", "name": "Rex", "size": "standard", "state": "running",
  "createdAt": "2026-10-08T19:02:11.412Z", "lastActiveAt": "2026-10-08T19:05:40.003Z",
  "snapshotAt": "2026-10-08T18:40:02.950Z" }
```

`state` is `starting`, `running`, `sleeping`, `stopping` or `error` (then `error` says why). `snapshotAt` appears once
the computer has slept.

| Request | Answer |
| --- | --- |
| `POST /computers` `{ "name"?, "size"?: "small" \| "standard" \| "large" }`, optional `Idempotency-Key` header | 201 `{ computer }` in state `starting`. It answers once Cloudflare has placed the container (1 to 16 s measured). Sizes: `standard-1` (½ vCPU, 4 GiB, 8 GB disk), `standard-2` (1 vCPU, 6 GiB, 12 GB; the default) and `standard-3` (2 vCPU, 8 GiB, 16 GB). The same key within 24 hours returns the same computer, with header `Idempotent-Replayed: true`. At `MAX_COMPUTERS`: 409 `limit_reached`. |
| `GET /computers` | `{ computers: [...] }` |
| `GET /computers/:id` | `{ computer }` or 404 |
| `PATCH /computers/:id` `{ "name" }` | `{ computer }` |
| `DELETE /computers/:id` | `{ deleted: true }`. Destroys the container and forgets the computer. |
| `POST /computers/:id/wake` | `{ computer }` in state `starting`. Boots from the latest snapshot, or from the image if it never slept. Poll `GET` until `running`. |
| `POST /computers/:id/sleep` | `{ computer }` in state `sleeping`. Snapshots the disk, then stops the container. Answers when done. |
| `POST /computers/:id/exec` `{ "command", "timeoutMs"? (default 120000, max 600000), "cwd"? }` | `{ exitCode, stdout, stderr, timedOut }`. Runs `bash -lc command` as `dog` in `/home/dog` with `DISPLAY=:0`. Each stream keeps its first 1 MiB. On timeout the command and everything it started are killed (exit 124). 409 `asleep` unless `running`. Exec never wakes a computer. |
| `GET /computers/:id/files?path=` | The file's bytes, 404 if missing, 413 over 16 MB. Relative paths start at `/home/dog`. |
| `PUT /computers/:id/files?path=` raw body | `{ ok: true }`. Up to 16 MB. Creates missing folders. New files and folders belong to `dog`. |
| `GET /computers/:id/screenshot` | `image/jpeg` of the whole screen, pointer included. |
| `POST /computers/:id/desktop` | `{ url, expiresAt }`: a viewer link valid for 2 hours. It is signed (HMAC-SHA256, secret `DESKTOP_SIGNING_KEY`) over the id, the expiry and the boot count, so it also dies when the computer sleeps. Anyone holding it can watch and take over: share it only with the person. 409 `asleep` unless `running`. |

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

Cloudflare limits image storage to 50 GB per account. List images with `wrangler containers images list` and remove old
ones with `wrangler containers images delete <image:tag>`.

## Checks

- `pnpm test`: unit tests for the pure logic. API key check, desktop link signing, ids, routing, input validation,
  output capture and the idle policy.
- `pnpm run check`: `wrangler types` and `tsc --noEmit`.
- `pnpm exec oxlint --deny-warnings deploy/laterdog/computers`, from the repository root.
- `pnpm run dry-run`: `wrangler deploy --dry-run`. This builds the image too.
- Local image smoke test (native arch): `docker build -t laterdog-computer:dev container && docker run --rm -p 6080:6080 laterdog-computer:dev`,
  then open http://localhost:6080/vnc.html.
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
expiry, recovery after Cloudflare restarts a host, the `small` and `large` sizes, the `MAX_COMPUTERS` cap, renaming
(`PATCH`), and the list endpoint with computers in it.

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
  the image; that is not confirmed.
- The screen is fixed at 1280×800. No audio. No clipboard or file transfer in the viewer: use the API.
- Files move 16 MB at a time. Command output keeps 1 MiB per stream.
- Commands get the environment in `src/computer.ts` (`DOG_ENV`) plus `PATH`, not the image's other variables.
- When a viewer's connection to the desktop ends, the runtime sometimes logs an uncaught `Network connection lost` on
  the Durable Object (twice in the viewer sessions we logged). Nothing failed with it: the request still succeeded, and
  the computer still went to sleep normally. The cause is not known.
