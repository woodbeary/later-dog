# later.dog Dev

later.dog Dev is a second copy of the desktop app that installs beside the released later.dog and shares nothing with it. The released app is for living in; Dev is for trying new builds, so building later.dog no longer touches the dogs, data, ports or keychain item you use every day.

Everything that names the app goes through one file, `electron/app-variant.cjs` (read as `electron/app-variant.mjs`). It decides `release` or `dev` before `electron/main.mjs` does anything else, and every name, folder, port and scheme below comes from it.

## How the variant is chosen

| Where it runs | Variant |
| --- | --- |
| Packaged app, baked `laterdogVariant: "dev"` in its `package.json`, or its bundle is named `later.dog Dev` | `dev` |
| Any other packaged app | `release` |
| Unpackaged Electron (`pnpm dev:desktop`, `electron .`) | `dev`, unless `LATERDOG_VARIANT=release` is set |
| Plain Node (tests, scripts) | `release`, unless `LATERDOG_VARIANT=dev` is set |

A packaged app ignores `LATERDOG_VARIANT`, so a stray variable cannot turn the release into Dev. If the two packaged identities ever disagree, the app becomes Dev, which owns nothing live. An unknown value is an error.

## What is separate

| | later.dog | later.dog Dev |
| --- | --- | --- |
| App id / name | `dog.later.app` / later.dog | `dog.later.app.dev` / later.dog Dev |
| Data folder | `~/.laterdog` | `~/.laterdog-dev` |
| Profile data | `~/.laterdog-profiles` | `~/.laterdog-dev-profiles` |
| `userData` (and so the single-instance lock) | `~/Library/Application Support/later.dog` | `~/Library/Application Support/later.dog Dev` |
| Logs (macOS) | Electron's default | `~/Library/Logs/later.dog Dev` |
| Keychain item (Electron safe storage) | later.dog Safe Storage | later.dog Dev Safe Storage |
| URL scheme | `laterdog://` | `laterdog-dev://` (the after-pack step removes the release's scheme from Dev's `Info.plist`; electron-builder would otherwise concatenate both, and the workflow fails if any scheme equals `laterdog`) |
| Computer-use host id | `dog.later.app` | `dog.later.app.dev` |
| Server ports (webhook is +1) | 8799, 18799, 28799 | 8999, 18999, 28999 |
| Remote-computer relay | 8798, 18798, 28798 | 8998, 18998, 28998 |
| Supervisor | 9010 | 9110 |
| Extra-profile servers | 8811 to 8899, even | 8911 to 8995, even |
| Updater feed | `latest-mac.yml`, cache `laterdog-updater` | `dev-mac.yml` on channel `dev`, cache `laterdog-dev-updater` |
| GitHub release check | on | off |
| Phone companion (control port) | 8810 (8811), `~/.laterdog-companion` | 8910 (8909), `~/.laterdog-dev/companion` |
| Local computer container, viewer port | `laterdog-computer`, 6080 | `laterdog-computer-dev`, 6180 |
| Icon | `electron/resources/app-icon.png` | `build/dev/icon.png` |
| Temp folders | `laterdog-*` | `laterdog-dev-*` |

`electron/app-variant.node-test.mjs` proves every row differs, that the two port sets never overlap, that Dev refuses to use the release's data folder even when `LATERDOG_HOME` names it, and that no other file in `electron/` spells out a release name, port or scheme by hand any more.

The released app's supervisor launch is unchanged: `electron/laterdog-supervisor.mjs` adds `LATERDOG_PORT` only for Dev, and the release's default stays 9010.

Three server details made this safe. `server/config.ts` used to rename a leftover `~/.laterdog-v0` into whatever data folder was in use; it now does that only for the default `~/.laterdog`, so Dev can never move a legacy folder. The supervisor's default address in `server/laterdog/config.ts` follows `LATERDOG_PORT`, which Dev sets to 9110. The local computer's container name and viewer port in `server/container-computer.ts` follow `LATERDOG_APP_VARIANT` (set to `dev` for Dev, removed for the release), through `server/variant-names.ts`.

Shared on purpose: the engines' own login folders (`~/.claude`, `~/.codex` and so on), external project folders a dog is pointed at, the standalone CuaDriver socket under `~/Library/Caches/cua-driver`, and the signed-in macOS permissions of the Speech helper. A Dev dog and a release dog pointed at the same project folder can edit the same files.

## Installing it

1. Push to the `dev` branch (the workflow file must be on `dev`). `.github/workflows/dev-app.yml` builds the app, signs it with the release's Developer ID secrets, notarizes and staples it, then replaces the rolling prerelease `dev-latest`.
2. On the repository's Releases page, open **later.dog Dev (rolling build of dev)**, download `later.dog-Dev-macOS-arm64.dmg`, and drag **later.dog Dev** into Applications. It sits beside later.dog and can run at the same time.
3. Open it. It starts empty. Nothing is copied from later.dog (see First run below).

The prerelease is never marked "latest", so the released app's updater and release check never see it.

## How updates arrive

Every push to `dev` builds `X.Y.Z-dev.N` (N is the workflow run number), uploads the zip, the disk image, `SHA256SUMS.txt` and `dev-mac.yml`, and replaces `dev-latest`. The app's feed is baked in as `https://github.com/<repo>/releases/download/dev-latest/` on channel `dev`, so it checks `dev-mac.yml` an hour apart, downloads in the background, and offers the usual **Restart to update** pill. A Dev build is a prerelease of its own version, so it never offers a release as an update.

Local packaging is not meant for this Mac. `LATERDOG_VARIANT=dev pnpm laterdog:package` follows the same path as CI (config `electron-builder.dev.yml`, `laterdogVariant` baked in, its own `app-update.yml` installed by the after-pack hook) if it is ever needed.

## Running dev scripts safely

`pnpm dev`, `pnpm dev:server`, `pnpm dev:desktop` and `pnpm laterdog:dev` used to hit port 8799 and `~/.laterdog`, which is the live app. They now go through `scripts/dev-safe.mjs`. The person's own tools (`laterdog:mcp`, `bridge`, `doctor`, `login`, `supervisor`, `github`) are not dev servers, so they keep the release defaults (`~/.laterdog`, supervisor 9010):

- Data is `~/.laterdog-dev-scripts`, the server is on 9011, the supervisor on 9111, the browser UI on 5199 (`pnpm dev`) or 5299 (`pnpm laterdog:dev`). `pnpm dev` proxies to 9011, so run `pnpm dev:server` beside it.
- `pnpm dev:desktop` runs unpackaged Electron as the Dev variant.
- Isolated runs also unset `LATERDOG_SUPERVISOR_URL`, `LATERDOG_TOKEN`, `LATERDOG_TOKEN_FILE`, `LATERDOG_DATA_DIR`, `LATERDOG_HARNESS_URL`, `LATERDOG_COMPANION_DIR` and `LATERDOG_WEBHOOK_PORT`, and set `LATERDOG_APP_VARIANT=dev` so their local computer and companion use Dev's names. Paths are compared after resolving symlinks and ignoring case on macOS.
- Pointing `LATERDOG_HOME` at the release's folders, or `LATERDOG_SERVER_PORT` / `LATERDOG_PORT` at the release's ports, stops with a message. Any other folder or port is fine.
- To use the live app on purpose, add `--use-my-live-dogs-and-real-data` (for example `pnpm dev:server -- --use-my-live-dogs-and-real-data`) or set `LATERDOG_USE_MY_LIVE_DOGS=1`. The command then prints a banner naming the live folder.
- `vite.config.ts` applies the same rule to `vite` and `vite serve` (not `vite build`), so running it directly cannot proxy to 8799 either.
- `pnpm mcp` looks for the Dev app on 8999 when `LATERDOG_VARIANT=dev`.

Verification still follows `docs/verification/README.md`: use an isolated fixture, never Dev's own folder or the live one.

## First run: copying your dogs (designed, not built)

Not built yet. It is bigger than one night because it has to prove the release's data is never written to. The design:

- **When:** Dev only, on first launch, when `~/.laterdog-dev` has no dogs and `~/.laterdog` exists. A card says **Copy my dogs from later.dog** with **Copy** and **Not now**; the answer is remembered in `userData`.
- **How:** reuse the workspace backup engine in `server/workspace-backup.ts`. Its snapshot uses SQLite's online backup, so the release can stay open, and it already leaves out credentials, device pairing, the server identity, leases and sockets. Restoring already pauses routines, webhooks and calendar calls. A copy is a snapshot restored into Dev's folder, never a move or a link.
- **One change needed first:** `createWorkspaceBackupSnapshot` writes its working folder under the folder it reads (`<source>/.backups`). That is a write into live data. Give it a separate working directory (inside Dev's folder) before using it here.
- **Proof to build with it:** a fixture test that hashes the source tree before and after and fails on any difference, and a check that every routine in Dev's copy is paused.
- **Not copied:** API keys and sign-ins (Dev asks again; a later, separate step could offer to copy them with the keychain prompt), phone pairing, cloud pairing.
- **Warn in the card:** dogs that work in an external project folder will still point at it.

## Verified and not verified

Verified here: the variant rules, every name, port and scheme above (unit tests), the dev-script guards, the build config's merge with the release config (loaded through electron-builder's own config reader), the workflow's shape and secret names, the icon sheet, the update feed file's contents.

Not verified: any packaged build (none was made), the workflow itself (it only runs on `dev`), notarization of a Dev app, Electron's actual Keychain service name for the Dev app (it is derived from the app name, which Dev sets, but this was not observed), the Dev single-instance lock beside a running release (it is keyed to `userData`, which differs), installing an update through `dev-mac.yml`, and the first-run copy.
