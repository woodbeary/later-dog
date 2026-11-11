# Rust, measured seam by seam (2026-11-10)

Jacob asked for a decision on Rust with evidence. Three options were compared:

1. Keep the desktop as it is built today (Electron shell, Node local server, React renderer) and improve it.
2. Add one small Rust component at a specific seam.
3. Replace the shell with a clean-sheet native one.

## Decision

Keep the current runtime. No Rust component ships, and the shell stays.

- No seam met the bar, which was a large gain against the improved Node path on something Jacob waits for.
- The measuring found two Node improvements instead. One is out as pull request #160 (the save lists a folder's files 32 at a time, which halves the walk). The other is written down under [Found on the way](#found-on-the-way).
- The clean-sheet shell used more memory than Electron on the one platform where both could be run, and opened a long chat about three times slower. It would also need its own updater, signing, permissions and a bundled Node.

Per seam:

| Seam | Decision | Reason |
| --- | --- | --- |
| Home save: listing and hashing the home | Keep Node | Rust takes the step from 1.8 s to 0.45 s, but the save around it takes 5.6 to 8.6 s on the fixture and 20 to 25 s on the real home, because of the database copy and the uploads. It runs in the background once a minute and the server stalls the same 30 ms either way. |
| Markdown parsing for long chats | Keep the JavaScript parser | Rust as WebAssembly parses the 30 rows a chat opens with in 4.5 ms instead of 14.6 ms. That is 10 ms of an open that takes 128 to 173 ms, and one of the twelve syntax samples (inline maths) came out as a different element tree. |
| Reading a chat from the database | Keep Node | PENDING |
| Local server memory | Keep Node | PENDING |
| Clean-sheet shell | Keep Electron | 410 MB against 310 MB idle, 347 to 483 ms against 128 to 173 ms to open the long chat, on Linux. Everything in [What a new shell has to bring](#what-a-new-shell-has-to-bring) would be rebuilt for that. |

## What each number is

Every number below is one of these, and each table says which:

- **Measured**: on the Linux cloud computer (x64, 4 cores, 12 GB, Node 24.22.2, rustc 1.99.1), against a synthetic fixture, with the run count shown. Timed runs held `~/heavy.lock` exclusively. Other lanes used the machine between runs, so compare rows inside one table, not across tables.
- **Observed on the real home**: taken from [the save headroom note](sync-snapshot-headroom-2026-11-10.md), read-only.
- **Read in code**: a file says so; nothing was run.
- **Not measured**: named, with the reason. Nothing here was measured on a Mac or an iPhone. Jacob's Mac was offline.

A time is a median with the lowest and highest run in brackets. Memory is peak resident memory (`VmHWM`) per process. For a Rust child process the tree is the Node process plus the child, added together. Correct means the Rust output was compared with the Node output on the first run of each row and was deeply equal.

## Fixtures

All synthetic, built by the scripts in `prototypes/rust-seam/`. No real home, chat or account was read.

| Fixture | Built by | What it holds |
| --- | --- | --- |
| Home | `save-walk/make-home.mjs build` | A 630 MB `messages.db` in WAL mode and 20,000 files of 0.5 to 256 KB in 80 dog folders: 21,443 entries, 1,015 MB. Between saves 300 files and the database change. |
| Crowded home | `save-walk/make-home.mjs tiny` | 140,000 one-line files in 800 dog folders: 171,198 entries. Between saves 300 files change. |
| Long chat | `markdown-wasm/bench-markdown.mjs`, `shell/hold-fixture.ts` | 240 messages (120 asks, 120 answers) with prose, lists, a code block and a table: 57,364 characters. |
| Chat database | `chat-open/make-chat-db.mjs` | A 718 MB `messages.db` with the server's own table and index: 131,491 rows in 401 chats. The 240-message long chat is spread through it. |
| Running server | `shell/hold-fixture.ts` | A disposable later.dog server with the repository's fake engine, the long chat and five other dogs with 12 messages each. |

## Home save

The home saves itself every 60 s (`deploy/laterdog/home/runtime/run.mjs`). A save lists the home, compares it with the last save, hashes what changed in 8 MiB pieces, copies a changed database with SQLite's backup, and uploads the pieces the store does not have (`runtime/sync.mjs`). The Rust prototype (`save-walk/src/main.rs`, a 575 KB binary) does the listing, the comparison and the hashing, and prints the listing for Node to parse. It does not copy the database or upload.

### Listing only

Measured. Home fixture, 7 runs each.

| Path | Time | Peak memory | Longest stall of the Node event loop | Correct |
| --- | ---: | ---: | ---: | --- |
| Node before: one file asked about at a time | 1,213 ms (1,099 to 1,868) | 87 MB | 2 ms | reference |
| Node now: a folder's files 32 at a time (pull request #160) | 613 ms (539 to 654) | 89 MB | 2 ms | yes |
| Node: synchronous calls in a worker thread | 435 ms (382 to 452) | 109 MB | 25 ms | yes |
| Node: synchronous calls on the main thread | 340 ms (318 to 374) | 92 MB | 335 ms | yes |
| Rust alone, nothing handed to Node | 158 ms (151 to 175) | 8 MB | none | not compared |
| Rust child process, listing parsed in Node | 232 ms (216 to 242) | 73 MB + 8 MB | 16 ms | yes |

Crowded home, 5 runs each.

| Path | Time | Peak memory | Longest stall | Correct |
| --- | ---: | ---: | ---: | --- |
| Node before | 16.6 s (12.5 to 17.7) | 215 MB | 12 ms | reference |
| Node now (pull request #160) | 8.0 s (6.3 to 9.1) | 216 MB | 11 ms | yes |
| Node: synchronous calls in a worker thread | 3.3 s (3.2 to 3.3) | 280 MB | 180 ms | yes |
| Rust alone | 1.6 s (1.6 to 1.6) | 44 MB | none | not compared |
| Rust child process, listing parsed in Node | 2.5 s (2.4 to 2.7), a later session | 158 MB + 139 MB | 151 ms | yes |

The same Rust walk took 1.6 s in one session and 2.3 s in the next, after the machine restarted. Two Node rows that run the same code (a folder's files 32 at a time, once from `sync.mjs` and once from `walk-variants.mjs`) came out at 613 ms and 774 ms. Differences under about a quarter are noise here.

### The whole step: list, compare, hash

Measured. Home fixture, 7 runs each, variants taking turns. 301 files changed, 379 pieces hashed, the 630 MB database hashed where it lies.

| Path | Time | Peak memory of the tree | Longest stall | Correct |
| --- | ---: | ---: | ---: | --- |
| Node before | 2,179 ms (2,119 to 3,764) | 330 MB | 29 ms | yes |
| Node now (pull request #160) | 1,756 ms (1,465 to 2,249) | 347 MB | 33 ms | reference |
| Node now, each file read into a buffer of its own size | 1,606 ms (1,275 to 1,926) | 148 MB | 14 ms | yes |
| Rust child process, 1 thread, listing parsed in Node | 823 ms (820 to 867) | 85 MB + 27 MB | 30 ms | yes |
| Rust child process, 4 threads, listing parsed in Node | 453 ms (420 to 466) | 85 MB + 52 MB | 34 ms | yes |

Crowded home, 5 runs each. 300 files changed.

| Path | Time | Peak memory of the tree | Longest stall | Correct |
| --- | ---: | ---: | ---: | --- |
| Node before | 16.6 s (13.4 to 26.3) | 395 MB | 135 ms | yes |
| Node now (pull request #160) | 8.8 s (8.0 to 15.0) | 571 MB | 149 ms | reference |
| Node now, each file read into a buffer of its own size | 8.4 s (6.8 to 9.7) | 367 MB | 141 ms | yes |
| Rust child process, 1 thread, listing parsed in Node | 3.1 s (2.9 to 3.2) | 219 MB + 139 MB | 265 ms | yes |
| Rust child process, 4 threads, listing parsed in Node | 3.0 s (3.0 to 3.1) | 219 MB + 139 MB | 259 ms | yes |

Starting the Rust binary from Node and waiting for it to end costs 3 ms (50 runs), against 2 ms for `/bin/true`. Parsing the crowded home's 30 MB listing is what stalls Node for 260 ms.

### The save around the step

PENDING

### Decision: keep Node

- On a home shaped like Jacob's the step is 1.8 s of a save that takes several seconds on the fixture and 20 to 25 s on the real home. Rust would take about 1.3 s off. Nobody waits on it: it runs in the background, and the server's longest stall is about 30 ms with either.
- The Rust path's memory advantage (137 MB against 347 MB) is mostly matched in Node by reading each file into a buffer of its own size (148 MB).
- On a home with 170,000 files the listing is the save, and Rust is 2.9 times faster than Node today. Node's own synchronous walk in a worker thread reaches 3.3 s for the listing, so the gain against the improved Node path is about a quarter. Jacob's home has thousands of files, not hundreds of thousands.
- Revisit if a real home's listing passes a few seconds per save. Try the worker thread first.

## Markdown for long chats

The renderer parses each message with the JavaScript markdown parser and five plugins, three of them later.dog's own, then `rehype-katex` (`src/components/ChatMarkdown.tsx`, read in code). Each message is memoised, so a message is parsed when it mounts and when its text changes. The Rust prototype (`markdown-wasm/src/lib.rs`) compiles a Rust markdown parser to WebAssembly: 453 KB, 109 KB compressed with Brotli. It returns the syntax tree as JSON, and the JavaScript plugins still run on it.

Measured in Node, not in the app's renderer. 40 passes each after warming.

| Messages parsed | JavaScript: parse | JavaScript: parse, then to elements | Rust: parse to a tree | Rust: tree, then to elements |
| --- | ---: | ---: | ---: | ---: |
| All 240 | 80.9 ms (67.8 to 117.4) | 96.3 ms (85.3 to 128.4) | 21.0 ms (18.2 to 39.2) | 34.9 ms (25.1 to 43.8) |
| The newest 120 | 39.2 ms (34.0 to 57.6) | 48.1 ms (41.5 to 87.7) | 10.9 ms (9.1 to 13.5) | 17.9 ms (15.1 to 26.7) |
| The newest 30, what a chat opens with | 12.4 ms (9.3 to 23.1) | 14.6 ms (9.9 to 38.8) | 2.8 ms (2.5 to 4.1) | 4.5 ms (4.3 to 5.0) |

One message, median over the 120 answers: 0.56 ms in JavaScript and 0.18 ms through Rust, both to elements.

In a fresh process, 15 processes: the first 30 messages take 57.8 ms (35.8 to 98.9) in JavaScript before its code is warm, and 8.0 ms (6.9 to 14.0) through Rust after 2.6 ms to compile the module. That happens once per launch.

Correctness, against the JavaScript parser:

| Texts | Same node types | Same tree, empty fields ignored | Same positions | Same elements after the plugins |
| --- | ---: | ---: | ---: | ---: |
| The 240 fixture messages | 240 | 240 | 200 | 240 |
| 12 syntax samples (maths, task lists, footnotes, links, nested lists, HTML, images, tables, accents) | 12 | 11 | 9 | 11 |

The sample that differs is inline maths: the Rust tree carries no rendering hint, so `rehype-katex` leaves it as text. One sample with accented letters and an emoji reports a different end column.

### Decision: keep the JavaScript parser

- A chat opens with its newest 30 rows (30 were mounted in the shell run below), which is 15 ms of parsing where the whole chat would be 96 ms. Rust takes a further 10 ms off an open measured at 128 to 173 ms.
- The once-per-launch gain is about 47 ms, measured in Node. It was not measured in the renderer.
- It would mean two parsers that have to agree for every message, on the desktop and on the phone, with one known difference already.

## Reading a chat from the database

PENDING

## Local server memory

PENDING

## Clean-sheet shell

No app was built. A 0.8 MB Rust shell that opens one window on the system webview (`shell/wry-shell`, the `tao` and `wry` crates, WebKitGTK 2.54 on this machine) loaded the real renderer from a fixture server, and so did a bare Electron 43.7.9 window (`shell/electron-shell.mjs`). The same script drove both (`shell/bench-shell.mjs`).

Measured. 7 launches each, each with a fresh profile. Memory is the whole process tree, read from `/proc/*/smaps_rollup` five seconds after the composer appeared and again after the long chat was opened twice.

| | Electron | Rust shell on the system webview |
| --- | ---: | ---: |
| Processes | 6 | 3 |
| Idle memory, shared pages counted once (PSS) | 310 MB (308 to 311) | 410 MB (408 to 410) |
| Idle memory, resident (RSS) | 644 MB (642 to 645) | 639 MB (637 to 640) |
| After the long chat, PSS | 445 MB (418 to 448) | 539 MB (533 to 548) |
| After the long chat, RSS | 792 MB (766 to 796) | 768 MB (762 to 777) |
| Launch to the composer | 921 ms (882 to 1,176) | 1,204 ms (1,079 to 1,461) |
| Open the long chat, first time | 173 ms (147 to 196) | 483 ms (416 to 589) |
| Open the long chat, again | 128 ms (116 to 175) | 347 ms (244 to 668) |
| Shell on disk | 316 MB | 0.8 MB, plus the system's 129 MB of webview libraries |

Limits of this measurement:

- Linux only, without a graphics card. On a Mac the system webview is a different build of the same engine. Not measured.
- Neither shell ran the local server, the tray, the updater or any helper. The server's own memory is in the section above and is the same under either shell.
- The renderer is tested in Chrome only (`control-laterdog ui`, [Chat UI](chat-ui.md)). Nothing checked that it behaves correctly in the system webview beyond reaching the composer and opening a chat.

### What a new shell has to bring

All read in code unless marked.

| What | Today | With a new shell |
| --- | --- | --- |
| Signing and notarising | `scripts/laterdog-release-mac.sh` runs on Jacob's Mac. electron-builder signs with the Developer ID identity and the hardened runtime, then `xcrun notarytool`, `stapler`, `spctl`. Only arm64 is released. | A new bundle layout, entitlements and nested signing order, written and proven from nothing. |
| Build tools on the Mac | The command line tools are enough: `codesign`, `notarytool`, `swiftc`, `lipo`. | A Rust shell adds a Rust toolchain per architecture (692 MB here, measured). An AppKit shell needs Xcode. Atelier's brief says Jacob's Mac has no Xcode; no file in the repository says so and the Mac was offline. Not checked. |
| Updates | electron-updater, bundled by `scripts/bundle-updater.mjs`, reads `latest-mac.yml` from the latest release and installs through Electron (`electron/updater.mjs`). An update receipt is kept. | A new updater, and one release of today's app that updates into the new one. Not tried. |
| Undoing a release | There is none: "apps never move to an older version" (`docs/laterdog/releasing.md`). | The same, and the first new-shell release could not be undone by an older one either. |
| Accessibility and Screen Recording | Checked and asked for in `electron/mac-permissions.mjs`; computer use needs both (`electron/cua-grant.mjs`). Usage strings in `electron-builder.yml`. | Re-implemented. Whether the Mac keeps Jacob's grants for a differently built app with the same identifier was not checked. |
| Dictation | A Swift helper app built with `swiftc` and `lipo` (`electron/build-speech-helper.mjs`), started with `open`, talking through files (`electron/speech.mjs`). | Reusable as it is. The glue is rewritten. |
| Shortcuts, tray, links, one instance, window state | Menu shortcuts (`electron/menu.mjs`), two tray icons, the `laterdog://` link, the single-instance lock and saved window state (`electron/main.mjs`). No global shortcut and no start-at-login was found. | Each rebuilt. |
| The local server | Runs on Electron's own Node (`utilityProcess.fork`), and the supervisor and tools start with `ELECTRON_RUN_AS_NODE` (`electron/laterdog-supervisor.mjs`, `server/index.ts`). No separate Node is bundled. | A Node runtime bundled and signed per architecture: 127 MB on this machine (measured). The server stays Node either way. |
| Engines | Command-line programs found on the person's `PATH` (`server/procs.ts`, `server/env-path.ts`). | Unchanged. They are not part of the shell. |
| The shell's own code | 104 files and about 17,170 lines in `electron/`, with 105 test files. | Rewritten, with its tests. |

### Decision: keep Electron

The one saving a system-webview shell offers is disk: about 190 MB once a Node runtime is added back. On memory and on opening a chat it measured worse on Linux, and it was not measured on a Mac. Against that stands rebuilding everything in the table with no way to take a bad release back.

## Packaging a Rust component, had one won

Nothing here was built into a package. Sizes and build times are measured on the Linux machine; the rest is read in code.

| | A native binary beside the server | A WebAssembly module in the renderer |
| --- | --- | --- |
| Size | 575 KB (save), 2.3 MB (chat open, with its own SQLite) | 453 KB, 109 KB with Brotli |
| Builds | One per target: macOS arm64 (and x64 if it is released again), Windows x64, Linux x64 for the desktop, and Linux x64 for the home image. | One for every platform. |
| Clean build | 10 s (save), 85 s (chat open, compiles SQLite), 21 s (markdown) | |
| Into the desktop bundle | A line under `extraResources` in `electron-builder.yml` from `dist-native/${arch}`, the way the computer-use driver ships. electron-builder signs it with the app. | Bundled by Vite like any asset. No signing. |
| Into the home image | `deploy/laterdog/home/Dockerfile` copies only the `runtime/` folder onto a `node:24-bookworm-slim` base. A binary needs a build stage or a pinned download, and has to be built against that base's C library, which is older than this machine's. | Does not apply. |
| Where it is built | There are no build workflows in this checkout; releases are made on Jacob's Mac (`docs/laterdog/releasing.md`). The Mac would need a Rust toolchain, or the binary would be built elsewhere and pinned by checksum. | The same toolchain question, once. |

## Migration and rollback

| Option | Getting there | Getting back |
| --- | --- | --- |
| Improved Node path | An ordinary pull request with tests. Pull request #160 is this. | Revert the commit. The saved format does not change. |
| One Rust component | Ship the binary switched off behind a setting. Run it in shadow first: Node does the work, Rust does it too, and any difference is logged. Then switch it on, falling back to the Node path on a missing binary, a non-zero exit, output that does not parse, or a timeout. The Node path stays and stays tested. | Switch the setting off. The Node path is still there, and the manifest and the database are the same format under both. |
| New shell | A parallel app until it matches the table above, then one release of today's app that updates into it. | None once people have updated. A newer release of the new shell is the only fix. |

## Found on the way

- **Shipped:** the save listed a folder one file at a time. Asking about 32 at once halves the listing (1,213 ms to 613 ms; 16.6 s to 8.0 s on the crowded home). Pull request #160.
- **Not shipped:** the save allocates an 8 MiB buffer for every changed file, however small (`chunksOf` in `runtime/sync.mjs`). Sizing the buffer to the file cut the save's peak memory from 347 MB to 148 MB on the home fixture and from 571 MB to 367 MB on the crowded home, at the same speed, and the listing still matched. The measurement used a patched copy of the file. It needs a test for a file that grows while it is read before it ships.
- **Not tried in the product:** listing the home with synchronous calls in a worker thread (435 ms against 613 ms; 3.3 s against 8.0 s on the crowded home). Worth it only for a home far more crowded than Jacob's.

## Run it again

On the cloud computer, with `~/.cargo/bin` on the `PATH`:

```sh
cd prototypes/rust-seam
(cd save-walk && cargo build --release)
(cd chat-open && cargo build --release)
(cd markdown-wasm && cargo build --release --target wasm32-unknown-unknown)
(cd shell/wry-shell && cargo build --release)

node save-walk/make-home.mjs build ~/rust-lane/home
node save-walk/bench-save.mjs --root ~/rust-lane/home --runs 7
node save-walk/make-home.mjs tiny ~/rust-lane/tiny --files 140000
node save-walk/bench-save.mjs --root ~/rust-lane/tiny --tiny --save-only --runs 5
node markdown-wasm/bench-markdown.mjs
node chat-open/make-chat-db.mjs ~/rust-lane/chat/messages.db
node chat-open/bench-chat-open.mjs --db ~/rust-lane/chat/messages.db --runs 7
pnpm exec vite build
node server-memory/bench-server.mjs --runs 5
node shell/bench-shell.mjs --electron node_modules/electron/dist/electron --wry shell/wry-shell/target/release/wry-shell --runs 7
```

The raw results of the runs reported here are in [`assets/rust-seams/`](assets/rust-seams/).

The Rust sources stay under `prototypes/rust-seam/` as measurement tools. They are not built or shipped by any package script. `scripts/no-comments.test.ts` covers `.rs` files and has a test that a Rust comment is caught.

## Still open

- Every number on a Mac: the shell comparison on the Mac's system webview, the save on the Mac's file system, the markdown parse in the app's renderer.
- Whether Jacob's Mac has Xcode, and whether the Mac keeps permission grants for a rebuilt app.
- The buffer sizing above, as its own change with a test.
