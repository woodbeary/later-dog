# The dev loop: desktop, phone and home together, with every log in one place

One command runs the later.dog Dev desktop and the phone app in Expo Go against a Cloud home, reloads code as it is
saved, and writes what every part says to one file.

```sh
pnpm dev:connect        # once: pair "later.dog dev tools" with your own home
pnpm dev:loop           # your own home
pnpm dev:loop --home test-<name>   # a test home that also reloads server code
```

## What runs

| Part | Against | Reloads | Log |
| --- | --- | --- | --- |
| later.dog Dev (Electron + Vite) | the chosen home, through `scripts/dev-home-proxy.mjs` | renderer edits under `src/` in about a second, no rebuild | `desktop` |
| Phone in Expo Go | Metro from `~/code/later-dog-phone` (`LATERDOG_PHONE_REPO`) | phone edits in seconds | `metro` (the phone's console lines land here too) |
| Home proxy on `0.0.0.0:8096` | the chosen home, adding its saved session | | `proxy`: every API call with status and time |
| Phone probe on `:8093` | the open Expo Go app | | `probe` |
| Server push (test homes only) | `pnpm dev:home watch --account test-<name>` | each save under `server/` or `shared/` runs on the test home in about 25-50 s | `push` |
| iPhone device log | `idevicesyslog -n`, Expo Go and later.dog processes only | | `iphone` (file only) |

Everything goes to `~/.laterdog-dev-tools/logs/all.log` as `HH:MM:SS source | line`, and each part also keeps its own
`<source>.log` beside it. Colour codes are removed.

## The two homes

- **Your own home** (`pnpm dev:connect` once). The session is in `~/.laterdog-dev-tools/my-home.session.json`, mode 600,
  as the signed-in device "later.dog dev tools"; sign it out from Settings, Account. The desktop and the phone show your
  real dogs and chats with hot-reloading screens. Server code there changes only with an image deploy.
- **A test home** (`node scripts/test-home.mjs sign-in test-<name>` first). Its Worker runs with `DEV_CODE=1`
  (`deploy/laterdog/home/wrangler.test.json` only; a config test keeps production and bootstrap at `""`), so it also
  takes server code pushed by `pnpm dev:home`: esbuild bundles the server, the bundle and `dev-code/current.json` go to
  the `laterdog-homes-test` bucket, and every test home lays the bundle over a copy of its image's server and restarts
  just the server process. If pushed code stops within 30 seconds, the home goes back to its image's server and says so
  in its log. `pnpm dev:home off` stops new pickups.

To point the phone at a test home, have the probe connect it: `node scripts/probe.mjs connect` in the phone repo uses
`EXPO_PUBLIC_LATERDOG_TEST_SERVER`, which the loop sets to the proxy.

## Away from home

When `~/.laterdog-dev-tools/tunnel.json` exists (mode 600, the run token of the Cloudflare Tunnel `laterdog-dev`), the
loop also runs that tunnel and `caffeinate -i -s` so the Mac stays awake, and the phone uses
`https://dev-metro.later.dog` (Metro, through `EXPO_PACKAGER_PROXY_URL`) and `https://dev-probe.later.dog` (the probe)
from any network. Open `exps://dev-metro.later.dog` in Expo Go.

Both hostnames sit behind the Access app "later.dog dev loop (phone)", whose only policy is a non-identity rule on the
Gateway posture check "later.dog dev: through this Zero Trust team": a request passes only from a device enrolled in the
`lucky-math-521d` Zero Trust team with the Cloudflare One client on, and anything else gets 403. Enrollment ("Warp
Login App") allows lopez731@gmail.com and jacob@lopez.com.ai, by one-time PIN or Cloudflare login. The home session proxy
is not on the tunnel.

## Home and Worker logs

Container stdout and stderr (the home server, its runtime, the edge) and Worker events are in Cloudflare Workers
Observability. Each home class is its own service, named by its container application id:

| Service | What |
| --- | --- |
| `a03ac9ad-82e3-42d0-9094-0e1cba80db2e` | production homes (standard) |
| `a0358541-08ed-4f4c-b044-0462b7352cc6` | production homes (large) |
| `a03c6272-83a7-4829-aeb6-b1f4db946154` | test homes (standard) |
| `laterdog-home`, `laterdog-home-test`, `laterdog-computers`, `laterdog-control-plane` | the Workers |

Query them with `POST /accounts/da1336ec3e3f7d9a4971022ae074c5d7/workers/observability/telemetry/query`, `view: "events"`,
filter `$metadata.service eq <service>`, newest first; `$metadata.message` holds the line. Wrangler's login has no
observability scope, so a script needs an API token with Workers Observability read; an agent session can use the
Cloudflare connector instead.

## Limits

- A server change on your own home still needs an image deploy (handoff-2026-10-19.md, "How images ship now").
- Native behaviour (keyboard, push, the computer viewer's native parts, a TestFlight-only crash) shows only on the
  phone; Expo Go and the web build cannot prove it.
- The probe reaches the phone only while Expo Go is open in front.
