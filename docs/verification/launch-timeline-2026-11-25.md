# Desktop launch timeline, 2026-11-25

Where desktop launch time goes, from process start to a message box a person can type in.
These are the "before" numbers for later launch work. Launch behaviour was not changed.

**Measured on Linux, under a virtual X display (`xvfb-run`), unpackaged app.** Same machine for every run:
4-core Intel Xeon at 2.10 GHz, 16 GB, kernel 6.18, Node 24.6.0, Electron from `node_modules`,
run as root and therefore with `--no-sandbox`. Nothing else ran during the measurement.
Raw marks for every run: [launch-timeline-2026-11-25.json](launch-timeline-2026-11-25.json).

## How it is measured

`LATERDOG_LAUNCH_TIMELINE=<file>` makes the desktop record named timestamps
([`electron/launch-timeline.mjs`](../../electron/launch-timeline.mjs)) and write them to that file when
the message box is ready, then again at quit with any marks that came later. Without the variable
the timeline is a shared no-op object: no listener, no renderer argument, no file.

- **Main process:** process start (`performance.timeOrigin`), imports done, `app.whenReady`, each await
  of the launch chain in `electron/main.mjs` (native splash, secure credentials, the packaged config,
  server start, supervisor, organization restore, organization and cloud entry), `createWindow`,
  window `ready-to-show`, page loaded and window shown, and the native splash shown and closed.
- **Renderer:** the main window gets `--laterdog-launch-timeline=1` and the preload then sends marks on
  `launch-timeline:mark`: preload start (with whether a first-paint snapshot was present), first
  contentful paint, `#root` filled, the launch splash shown and leaving, and **message box ready**: the
  composer textarea is in the page, no launch splash element remains and the page is visible. The main
  process accepts these only from the window it watches.
- **Message box on screen** is the later of message box ready and first contentful paint. In repeat
  launches the box is ready a few milliseconds before the first pixel reaches the screen.

The runner ([`scripts/launch-timeline.mjs`](../../scripts/launch-timeline.mjs)) does each launch in a fresh
temporary folder (its own `HOME`, data folder and desktop profile, Dev variant) and refuses to start if
that folder overlaps any installed or Dev later.dog data or profile folder, if live data is asked for,
or if any port an installed or Dev later.dog owns is in use. It stops nothing.

The unpackaged app does not start its own server; it loads `ELECTRON_START_URL` and still calls its
server at the Dev variant's port 8999 during launch. So for each launch the runner starts the bundled
server (`dist-server/index.js`, the code the packaged app forks) on port 8999, serving the built
interface from `dist` the way the packaged app serves `resources/ui`, waits for it with the app's own
health probe, then spawns Electron. That server boot is reported on its own row, outside the app.

A **first launch** uses a new folder every time, so there is no first-paint snapshot. A **repeat launch**
reuses one folder that a warm-up launch (not counted) prepared, so the snapshot is present. The two
kinds alternate. Every launch waits 2.5 s after the message box is ready so the snapshot is saved,
then quits the app with SIGTERM. The record confirms the snapshot was absent in all 12 first launches
and present in all 12 repeat launches. No run failed, retried or timed out.

```
pnpm exec vite build && pnpm build:server
node scripts/launch-timeline.mjs --runs 12 --out <file>
```

On Linux without a display it re-runs itself under `xvfb-run -a`. `--keep` keeps the folders and logs.

## Numbers

Milliseconds, n = 12 each, nearest-rank p95. "Total" starts when the runner spawns Electron.

| Segment | First: median | p95 | range | Repeat: median | p95 | range |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Electron boot (spawn → main process start) | 26 | 37 | 24–37 | 32 | 38 | 24–38 |
| Main imports | 130 | 142 | 118–142 | 135 | 153 | 120–153 |
| Imports → app ready | 60 | 108 | 55–108 | 59 | 81 | 53–81 |
| Startup checks (move offer, cache eviction) | 36 | 65 | 32–65 | 2 | 4 | 1–4 |
| Native splash wait (created → shown) | 81 | 95 | 71–95 | 100 | 114 | 87–114 |
| Secure credentials | 0 | 1 | 0–1 | 0 | 1 | 0–1 |
| Credential state | 0 | 1 | 0–1 | 0 | 1 | 0–1 |
| Server start in app (skipped unpackaged) | 0 | 0 | 0–0 | 0 | 0 | 0–0 |
| Supervisor (skipped unpackaged) | 0 | 0 | 0–0 | 0 | 0 | 0–0 |
| Organization restore | 3 | 3 | 2–3 | 3 | 3 | 2–3 |
| Organization and cloud entry | 0 | 0 | 0–0 | 0 | 0 | 0–0 |
| **App ready → createWindow** | **219** | 276 | 198–276 | **204** | 231 | 191–231 |
| createWindow → ready-to-show | 273 | 307 | 243–307 | 249 | 281 | 244–281 |
| createWindow → page loaded | 271 | 306 | 242–306 | 248 | 279 | 243–279 |
| createWindow → window shown | 311 | 348 | 280–348 | 347 | 386 | 337–386 |
| createWindow → first paint | 333 | 370 | 305–370 | 385 | 429 | 375–429 |
| **Window shown → message box on screen** | **1066** | 1069 | 1060–1069 | **36** | 50 | 31–50 |
| Native splash on screen | 347 | 384 | 311–384 | 382 | 423 | 372–423 |
| Launch splash shown → leaving | 709 | 712 | 707–712 | not shown | | |
| Launch splash leaving → gone | 362 | 364 | 361–364 | not shown | | |
| Main process start → message box on screen | 1805 | 1849 | 1723–1849 | 796 | 847 | 757–847 |
| **Total: spawn → message box on screen** | **1830** | 1876 | 1748–1876 | **829** | 879 | 790–879 |
| Fixture server boot, outside the app | 1164 | 1283 | 1095–1283 | 715 | 768 | 660–768 |

Gaps the table does not break out, medians from the same runs (first / repeat): app ready → native
splash created 103 / 71 ms (startup checks plus building the splash window); preload start 87 / 81 ms
after `createWindow`; page loaded → `#root` filled 36 / 96 ms; `#root` filled → window shown 5 / 4 ms;
window shown → first paint 22 / 36 ms.

Verdict: **measured** for this configuration. The first launch spends 1.07 s of its 1.83 s after the
window is already showing, behind the launch splash. The repeat launch skips that splash and is ready
in 0.83 s.

## What is not measured

- **The packaged Mac app.** No macOS window server, no signed bundle, no `utilityProcess` server.
  Packaged-only steps all show 0 here: the in-app server start with its health poll, the supervisor
  spawn, the Composio and workspace config, the companion cleanup.
- **The in-app server start.** The fixture server row is a stand-in only: plain Node outside Electron,
  no compile cache, no lease, timed by the same probe. In the packaged app this time sits inside
  "app ready → createWindow".
- **Keychain access on macOS.** On Linux without a keyring the credential store read takes under 1 ms.
- **A sleeping Cloud home**, a remote environment as the active workspace, a configured cloud account
  or an organization entry. Every launch here is a local workspace with none of those.
- **A real workspace.** The data folder holds only what a new install creates; the snapshot holds the
  main dog and no long chats.
- **GPU paint.** Xvfb renders in software. Absolute paint times on a real display will differ.
- **When the store finished hydrating** on a first launch. There is no renderer mark for it, only the
  splash leaving, which the 700 ms hold bounds from below.

## What the timeline shows

Findings only; none of this was changed.

1. **The window waits for the whole chain.** `createWindow` runs only after every await in
   `app.whenReady` (`electron/main.mjs`): 204–219 ms median here, and in the packaged app also the
   keychain read, the Composio and workspace config, the server start with its health poll (the
   stand-in alone is 0.7–1.2 s) and organization restore. Creating the `BrowserWindow` and starting its
   renderer (preload runs about 85 ms after `createWindow`) depends on none of them; only the URL it
   loads depends on the server.
2. **Serial awaits, and which of them are independent.**
   - `await startupScreen.ready` holds the chain until the native splash is shown (81 / 100 ms). The
     credential read, environments and organization restore after it do not use the splash.
   - `loadSecureCredentials`, then `secureComposioConfig`, then `secureWorkspaceConfig` run one after
     another before the server start. The two config steps both rewrite `config.json` and the
     credential document, so they depend on each other; the window itself uses neither.
   - `organizationEntry.restore`, `deliverOrganizationEntry` and `cloudEntry.ready` are awaited in turn
     after the server start. They decide which window opens, so they gate `createWindow`; a restore
     can open the settings window, which loads from the server, so they are not independent of it.
   - `startLaterDogSupervisor` only spawns a process and returns, so it costs little even though it is
     awaited.
3. **Two splashes on a first launch.** The native splash is on screen 347 ms. When it closes, the
   window opens on the launch splash in `src/components/LaunchSplash.tsx` for another 1,066 ms: a
   709 ms hold (floor `SPLASH_MIN_MS` 700) and a 362 ms fade (`SPLASH_FADE_MS` 360). The splash left
   within 7–12 ms of the 700 ms floor in all 12 runs, so the data was ready before the floor and the
   hold set the time. About 1.06 s of the 1.83 s first launch is deliberate hold and fade.
4. **What the window waits for when it could already paint.**
   - On a first launch the window is shown and painted 311–333 ms after `createWindow`, but the
     message box stays behind the launch splash for over a second, ready but covered.
   - The main window is created hidden while the native splash exists and is revealed only once
     `#root` has children (`startupScreen.attach`); the reveal follows within about 5 ms, so that wait
     is the renderer's own first render, not extra delay.
   - With a snapshot, `src/main.tsx` still waits for the brand and session answers before painting.
     `paintedBeforeSession` paints from the snapshot early only if they take longer than 300 ms
     (`FIRST_PAINT_SESSION_WAIT_MS`). Against the local server here they answered sooner, so the
     snapshot made the first render heavier (page loaded → `#root` filled 96 ms against 36 ms) but did
     not make it earlier. The repeat launch is faster because it skips the launch splash.
5. **Before the chain starts.** Main-process imports take 130 ms and the first-launch startup cache
   eviction 36 ms; both run before anything is on screen.
