# later.dog Dev

later.dog Dev is a second copy of the desktop app that installs beside the released later.dog and shares nothing with it. The released app is for living in; Dev is for trying new builds, so building later.dog no longer touches the dogs, data, ports or keychain item you use every day.

Everything that names the app goes through one file, `electron/app-variant.cjs` (read as `electron/app-variant.mjs`). It decides `release` or `dev` before `electron/main.mjs` does anything else, and every name, folder, port and scheme below comes from it.

## The app you work in

`pnpm dev:app` installs **later.dog Dev** in Applications, next to later.dog (in `~/Applications` when the main folder isn't writable), and removes a copy it installed in the other folder. Open it like any app, from Applications or the Dock. It runs this checkout from source (the `pnpm dev:desktop` session below), so its dogs can work on later.dog from inside it:

- A file saved under `src/` shows up in the open window within about a second. Nothing is built.
- Changes under `server/` and `electron/`, and `shared/` code the server uses, load with **later.dog Dev → Restart later.dog Dev**, which takes a few seconds.
- Its data is `~/.laterdog-dev`. The released later.dog, its dogs and its sign-ins are never touched. The engines' own sign-ins on this Mac (Claude, ChatGPT and the rest) are shared, so its dogs work straight away.

When a change breaks it:

- Each time it opens, it saves the code it ran, uncommitted and new files included, as `refs/laterdog-dev/opened/<time>` in this repository and keeps the newest 12. Your branch, index and files are not touched.
- If it can't start, it shows the file, line and error, and offers **Try Again** or **Open an Earlier Version…**.
- **later.dog Dev → Open an Earlier Version…** does the same from a running app, for a change that broke the window rather than the start.
- An earlier version runs from its own checkout, `~/.laterdog-dev-tools/app/earlier`, with the same dogs and chats, so a dog there can fix this checkout. **Back to the Latest Code** in the same menu returns.

How it is put together: the app is an APFS clone of this checkout's Electron, so it takes no extra disk, renamed later.dog Dev (`dog.later.app.dev.source`) with the Dev icon and a small launcher as its executable. The launcher starts a keeper, `scripts/dev-app.mjs` copied into the app so a broken checkout can't break it, which runs `scripts/dev-desktop.mjs` with `LATERDOG_DEV_ELECTRON` pointing at the renamed Electron. The window, Dock tile and menu bar therefore all say later.dog Dev, and clicking the icon while it is open brings it to the front. The two menu items, from `electron/dev-session-menu.mjs`, quit through the normal shutdown with exit code 75 (restart) or 76 (earlier version), and the keeper acts on the code. When `pnpm install` moves Electron to a new version, the keeper rebuilds the app before the next start. Run `pnpm dev:app` again after changing `scripts/dev-app.mjs`. Logs are in `~/Library/Logs/later.dog Dev`: `keeper.log`, `session.log`, and `session.previous.log` for the session before.

Verified on 2026-10-27 on a throwaway clone with its own data:
- opening from the icon took 11.6 s cold and about 3 s warm;
- a Claude dog edited the clone's `src/locales/en.json` from inside the app, and the window changed a second later;
- Restart brought the window back in 2.2 s;
- a broken server showed the dialog with its file, line and error;
- the last version that worked opened with the same chat, and going back to the latest code worked;
- a second click on the icon focused the open app without starting another.

Not verified:
- clicking the menu items themselves (the test made the same quit-with-code call they make);
- the Electron rebuild after a version change;
- macOS permission prompts, such as the microphone or the screen, for the renamed app.

## How the variant is chosen

| Where it runs | Variant |
| --- | --- |
| Packaged app, baked `laterdogVariant: "dev"` in its `package.json`, or its bundle is named `later.dog Dev` | `dev` |
| Any other packaged app | `release` |
| Source launcher (`pnpm dev:desktop`) | `dev` |
| Other unpackaged Electron (`electron .`) | `dev`, unless `LATERDOG_VARIANT=release` is set |
| Plain Node (tests, scripts) | `release`, unless `LATERDOG_VARIANT=dev` is set |

A packaged app ignores `LATERDOG_VARIANT`, so a stray variable cannot turn the release into Dev. If the two packaged identities ever disagree, the app becomes Dev, which owns nothing live. An unknown value is an error.

## What is separate

These are the packaged apps' defaults. The source launcher isolates its native
profile under its selected workspace, as described below.

| | later.dog | later.dog Dev |
| --- | --- | --- |
| App id / name | `dog.later.app` / later.dog | `dog.later.app.dev` / later.dog Dev |
| Data folder | `~/.laterdog` | `~/.laterdog-dev` |
| Old profile data (kept on disk and protected; desktop profiles are gone) | `~/.laterdog-profiles` | `~/.laterdog-dev-profiles` |
| `userData` (and so the single-instance lock) | `~/Library/Application Support/later.dog` | `~/Library/Application Support/later.dog Dev` |
| Logs (macOS) | Electron's default | `~/Library/Logs/later.dog Dev` |
| Keychain item (Electron safe storage) | later.dog Safe Storage | later.dog Dev Safe Storage |
| URL scheme | `laterdog://` | `laterdog-dev://` (the after-pack step removes the release's scheme from Dev's `Info.plist`; electron-builder would otherwise concatenate both, and the workflow fails if any scheme equals `laterdog`) |
| Computer-use host id | `dog.later.app` | `dog.later.app.dev` |
| Server ports (webhook is +1) | 8799, 18799, 28799 | 8999, 18999, 28999 |
| Remote-computer relay | 8798, 18798, 28798 | 8998, 18998, 28998 |
| Supervisor | 9010 | 9110 |
| Reserved, unused since desktop profiles were removed | 8811 to 8899, even | 8911 to 8995, even |
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

## Local renderer hot reload

From the checkout, run `pnpm dev:desktop`. No package build or CI is involved.
The launcher uses Node 24+ (including an installed nvm runtime), prepares the
existing tunnel helper, then starts the source supervisor, API and Vite. It opens
unpackaged Electron only after all three are ready. The window loads Vite on
`http://127.0.0.1:5299`, with API port 8999 and supervisor port 9110.

Edit a renderer file under `src/` to use Vite hot reload. Quit the Dev app or press
Ctrl-C to stop this command's processes. Restart the command after a server or
Electron main-process edit. An occupied port stops startup; the launcher never
kills an existing app or silently changes the UI port.

This command uses the Dev identity, workspace `~/.laterdog-dev` and native profile
`~/.laterdog-dev/desktop`. A custom isolated `LATERDOG_HOME` moves both the workspace
and native profile: Electron derives its `userData` from `<LATERDOG_HOME>/desktop`,
ignoring an inherited `LATERDOG_USER_DATA` override. Release data folders, installed
app profiles, escaping profile symlinks and live-data flags are refused. Packaged
Dev keeps its Application Support profile from the table above.

It does not copy release data and can coexist with the release app. Close any
other Dev session first because the source API and supervisor ports are fixed.
A nonreserved `LATERDOG_UI_PORT` is supported.

Native Cloud sign-in remains gated to packaged apps. The isolated
[`desktop-signin` fixture](../verification/desktop-signin.md) covers the source
renderer with fake accounts; starting this command does not prove real native
email sign-in.

The launcher lifecycle, environment isolation and existing variant rules passed
focused local tests. An isolated source-server/Vite run delivered a stylesheet
update over the HMR websocket, served the changed module, and delivered the
restoration after the edit was undone. Electron was replaced with an idle test
child for that check. Actual window launch, visual refresh and simultaneous
release/Dev windows still need a check on the selected Mac; no screen verification
is implied by the protocol test.

## Installing it

For everyday work use `pnpm dev:app` ([the app you work in](#the-app-you-work-in)). A packaged Dev build is only for checking packaging.

The rolling `dev-latest` build stopped when its workflow was removed on 2026-10-19, and the `dev` branch is retired with it. Build Dev locally when it is needed: `LATERDOG_VARIANT=dev pnpm laterdog:package` uses `electron-builder.dev.yml`, bakes in `laterdogVariant`, and installs Dev's own `app-update.yml` through the after-pack hook. Drag **later.dog Dev** into Applications; it sits beside later.dog, can run at the same time and starts empty (see First run below). Day-to-day testing runs on isolated fixtures instead ([docs/verification/README.md](../verification/README.md)).

## How updates arrive

A Dev app's feed is baked in as `https://github.com/<repo>/releases/download/dev-latest/` on channel `dev`. Nothing publishes there any more, so a local Dev build offers no updates; build it again instead. A Dev build is a prerelease of its own version, so it never offers a release as an update.

## Running dev scripts safely

`pnpm dev`, `pnpm dev:server`, `pnpm dev:desktop` and `pnpm laterdog:dev` used to hit port 8799 and `~/.laterdog`, which is the live app. The browser and server commands go through `scripts/dev-safe.mjs`; desktop uses `scripts/dev-desktop.mjs`. Your own tools (`laterdog:mcp`, `bridge`, `doctor`, `login`, `supervisor`, `github`) are not dev servers, so they keep the release defaults (`~/.laterdog`, supervisor 9010):

- Data is `~/.laterdog-dev-scripts`, the server is on 9011, the supervisor on 9111, the browser UI on 5199 (`pnpm dev`) or 5299 (`pnpm laterdog:dev`). `pnpm dev` proxies to 9011, so run `pnpm dev:server` beside it.
- `pnpm dev:desktop` starts the complete local Dev session described above, using workspace `~/.laterdog-dev`, native profile `~/.laterdog-dev/desktop`, API 8999, supervisor 9110 and Vite 5299. It does not use the script-only defaults in the previous bullet.
- Isolated runs also unset `LATERDOG_SUPERVISOR_URL`, `LATERDOG_TOKEN`, `LATERDOG_TOKEN_FILE`, `LATERDOG_DATA_DIR`, `LATERDOG_HARNESS_URL`, `LATERDOG_COMPANION_DIR` and `LATERDOG_WEBHOOK_PORT`, and set `LATERDOG_APP_VARIANT=dev` so their local computer and companion use Dev's names. Paths are compared after resolving symlinks and ignoring case on macOS.
- Pointing `LATERDOG_HOME` at the release's folders stops with a message. Browser and server commands also reject `LATERDOG_SERVER_PORT` / `LATERDOG_PORT` set to release ports. Desktop fixes its API and supervisor ports and checks that its renderer port is not reserved.
- For browser and server commands only, using the live app requires `--use-my-live-dogs-and-real-data` (for example `pnpm dev:server -- --use-my-live-dogs-and-real-data`) or `LATERDOG_USE_MY_LIVE_DOGS=1`. The command then prints a banner naming the live folder. The desktop launcher always refuses these flags.
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
