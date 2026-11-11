# Rust, measured seam by seam (2026-11-10 and 11)

Jacob asked for a decision on Rust with evidence. Three options were compared:

1. Keep the desktop as it is built today (Electron shell, Node local server, React renderer) and improve it.
2. Add one small Rust component at a specific seam.
3. Replace the shell with a clean-sheet native one.

## Decision

Keep the current runtime. No Rust component ships, and the shell stays.

- No seam met the bar, which was a large gain against the improved Node path on something Jacob waits for. Two seams gained nothing at all: reading a chat from the database is as fast in Node as in Rust, and no Rust helper takes memory away from the local server.
- The measuring found two Node improvements instead. One is out as pull request #160 (the save lists a folder's files 32 at a time, which halves the walk). The other is written down under [Found on the way](#found-on-the-way).
- The clean-sheet shell used more memory than Electron on the one platform where both could be run, and opened a long chat about three times slower. It would also need its own updater, signing, permissions and a bundled Node.

Per seam:

| Seam | Decision | Reason |
| --- | --- | --- |
| Home save: listing and hashing the home | Keep Node | Rust takes the step from 1.8 s to 0.45 s, but the save around it takes 5.5 s on the fixture and 20 to 25 s on the real home, because of the database copy and the uploads; it runs in the background once a minute and the server stalls the same 30 ms either way. |
| Markdown parsing for long chats | Keep the JavaScript parser | Rust as WebAssembly parses the 30 rows a chat opens with in 4.5 ms instead of 14.6 ms. That is 10 ms of an open that takes 128 to 173 ms, and one of the twelve syntax samples (inline maths) came out as a different element tree. |
| Reading a chat from the database | Keep Node | A Rust helper kept running reads the 50 rows a chat opens with in 0.17 ms against Node's 0.16 ms, and one started for each open takes 3.9 ms; either way the read is about a thousandth of the 128 to 173 ms the window takes to show the chat. |
| Local server memory | Keep Node | The server idles at 210 MB in one Node process, and every Rust helper measured here is a further process of 4 to 139 MB beside it, so a helper adds memory and only rewriting the server's 126,000 lines could take any away. |
| Clean-sheet shell | Keep Electron | 410 MB against 310 MB idle, 347 to 483 ms against 128 to 173 ms to open the long chat, on Linux. Everything in [What a new shell has to bring](#what-a-new-shell-has-to-bring) would be rebuilt for that. |

## The three options, against what Jacob asked

Each cell says where it comes from: measured (on the Linux cloud computer, against a fixture), release (read off the published 0.3.46 release), read in code, or not measured. Nothing in this table was measured on a Mac.

| Asked | 1. Improved current desktop | 2. One small Rust component | 3. Clean-sheet shell |
| --- | --- | --- | --- |
| Memory of the process tree | Window: 310 MB idle and 445 MB after the long chat, in 6 processes. Local server: 210 MB idle in 1 process, and 511 MB in 7 processes once six dogs have answered, 273 MB of it the server. Window and server together idle at about 520 MB (added from the two). All measured, shared pages counted once. Sizing the save's buffer to the file takes the save's peak from 347 MB to 148 MB (measured). | The same window and server, plus one process per helper: 4.4 MB for a chat reader, 27 to 52 MB for the save step on the home fixture, 139 MB on the crowded home (measured). The save's own tree is 137 MB against 347 MB today and 148 MB with the Node fix. A WebAssembly parser adds no process; its memory inside the window was not measured. | Window: 410 MB idle and 539 MB after the long chat, in 3 processes (measured). The server is the same process either way, so about 620 MB together. |
| Something Jacob waits for | Opening the long chat: 173 ms the first time, 128 ms again. Launch to the composer: 921 ms (measured). Pull request #160 halves the save's listing, which nobody waits for. | Opening a chat: the database read is 0.16 ms in Node and 0.17 ms through a helper, so nothing (measured). The markdown parse is 14.6 ms in JavaScript and 4.5 ms through WebAssembly, so about 10 ms of 128 to 173 ms (measured in Node, not in the window). The save is not waited for. | Opening the long chat: 483 ms the first time, 347 ms again. Launch to the composer: 1,204 ms (measured). |
| Size | The 0.3.46 download is 249 MB as a disk image and 251 MB as the update archive, arm64 only (release). The bare shell is 316 MB on disk on Linux (measured). | Adds 0.6 MB for the save step or 2.3 MB for a chat reader, per architecture, or 0.45 MB of WebAssembly once (measured, Linux builds). | A 0.8 MB shell, plus a 127 MB Node runtime it now has to bring (measured, Linux), plus the renderer, the server and the helpers shipped today. About 190 MB less on disk. No package was built. |
| Signing and notarising on macOS | Unchanged. `scripts/laterdog-release-mac.sh` signs with the Developer ID identity and the hardened runtime, notarises and staples the app and the disk image, and checks both with `spctl` (read in code). | A native binary goes under `extraResources`, where electron-builder signs it with the app, the way the computer-use driver ships (read in code). It is one more executable for the notary to accept. Not tried. WebAssembly needs no signing. | A new bundle layout, entitlements and signing order, and the release script's checks rewritten for it. Not tried. |
| Universal build | There is none. `electron-builder.yml` lists arm64 and x64 as separate builds, and the release script builds and publishes arm64 only (read in code, release). | One binary per architecture under `dist-native/${arch}`, each from its own Rust target, or the two joined with `lipo`. WebAssembly is one file for every platform. Not built for a Mac. | A shell and a Node runtime per architecture. Not built. |
| Updater | electron-updater reads `latest-mac.yml` from the latest release and installs the archive; an update receipt is kept (read in code). | Unchanged. The component sits inside the app and updates with it. | A new updater, and one release of today's app whose update is the new app. Not tried. |
| Migration | Ordinary pull requests with tests. Pull request #160 is one. | Ship it switched off, run it in shadow beside the Node path and log any difference, then switch it on with the Node path as the fallback. | A second app built until it matches everything in [What a new shell has to bring](#what-a-new-shell-has-to-bring), then the bridging release. |
| Taking a bad release back | Apps never move to an older version (`docs/laterdog/releasing.md`), so it is a newer release with the commit reverted. The saved formats do not change. | Switch the setting off. The Node path is still there and still tested, and the saved formats are the same under both. | Nothing. Once people have updated, only a newer release of the new shell reaches them. |

Steps and details for the last two rows are in [Migration and rollback](#migration-and-rollback); packaging for a component is in [Packaging a Rust component, had one won](#packaging-a-rust-component-had-one-won).

## What each number is

Every number below is one of these, and each table says which:

- **Measured**: on the Linux cloud computer (x64, 4 cores of an AMD EPYC 9684X, 12 GB, Node 24.22.2, rustc 1.99.1), against a synthetic fixture, with the run count shown. Timed runs held `~/heavy.lock` exclusively. Other lanes used the machine between runs, and it restarted twice, so compare rows inside one table, not across tables.
- **Release**: read off the published 0.3.46 release's file list on 2026-11-11.
- **Observed on the real home**: taken from [the save headroom note](sync-snapshot-headroom-2026-11-10.md), read-only.
- **Read in code**: a file says so; nothing was run.
- **Not measured**: named, with the reason. Nothing here was measured on a Mac or an iPhone. Jacob's Mac was offline on the 10th and busy with other work on the 11th, and this lane did not use it.

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

Measured. Home fixture, 7 runs each, a fresh process per run. Each row adds one thing to the row above. 301 files changed, 379 pieces checked against the store, 302 uploaded (20.7 MB).

| What the save does | Time | Peak memory | Longest stall |
| --- | ---: | ---: | ---: |
| List, compare, hash, with the store in memory | 1,670 ms (1,472 to 2,088) | 323 MB | 29 ms |
| The same, plus the copy of the 630 MB database (SQLite's backup into scratch) | 4,648 ms (4,514 to 5,079) | 296 MB | 22 ms |
| The same, with the store asked over HTTP on the same machine | 5,470 ms (5,325 to 5,982) | 385 MB | 22 ms |

A fourth row, with a store that answers each request after 30 ms, was cut off by a restart of the machine and is not reported.

The database copy is about 3.0 s of the 5.5 s and the store about 0.8 s. The step Rust could replace is the first row. A whole save with the Rust step in it was not run: taking the 1.3 s it saves off the last row gives about 4.2 s, by subtraction. On the real home the copy alone holds the disk for 20 to 25 s of every minute ([the save headroom note](sync-snapshot-headroom-2026-11-10.md), observed).

### Decision: keep Node

- On a home shaped like Jacob's the step is 1.8 s of a save that takes 5.5 s on the fixture and 20 to 25 s on the real home. Rust would take about 1.3 s off. Nobody waits on it: it runs in the background, and the server's longest stall is about 30 ms with either.
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

Opening a chat asks the local server for the newest rows of one thread: one indexed query on `messages`, a second for the active branch, then `JSON.parse` for each row (`readThreadTail` in `server/message-db.ts`, read in code). The Rust prototype (`chat-open/src/main.rs`, a 2.3 MB binary with its own SQLite) runs the same statements and prints the same answer as text, which Node still has to parse.

Measured. Chat database fixture, 7 fresh processes per row, the four paths taking turns. Each process opens the 240-message chat 200 times (30 times where a process is started for every open). A cell is the median open inside a process, then the median, lowest and highest of the 7 processes. The first open of every row was compared with Node's answer and was deeply equal.

| Path | The newest 50 rows (17.5 KB) | The whole chat, 240 rows (81.5 KB) | First open in a fresh process, 50 rows | Peak memory of the tree |
| --- | ---: | ---: | ---: | ---: |
| Node today: a statement prepared on every open | 0.155 ms (0.147 to 0.170) | 0.567 ms (0.493 to 0.614) | 1.6 ms (1.4 to 32.2) | 60 MB |
| Node with its three statements prepared once | 0.143 ms (0.104 to 0.172) | 0.537 ms (0.457 to 0.564) | 1.6 ms (1.4 to 1.7) | 60 MB |
| Rust: a child process started for every open | 3.885 ms (3.670 to 4.171) | 6.037 ms (4.855 to 6.304) | 8.0 ms (6.8 to 15.3) | 58 MB, child not read |
| Rust: one child process kept running, asked over a pipe | 0.172 ms (0.164 to 0.181) | 0.619 ms (0.552 to 0.635) | 6.8 ms (5.9 to 9.2) | 55 MB + 4 MB |

The same measurement before the machine restarted, 7 processes again, gave 0.172, 0.154, 4.247 and 0.170 ms for the newest 50 rows and 0.660, 0.625, 7.551 and 0.728 ms for the whole chat, in the same row order. The kept-running helper is level with Node at best and a tenth slower otherwise. It is never faster.

Through the running fixture server, the whole request for the newest 50 rows takes 1.0 ms (1.0 to 1.1) over HTTP on the same machine (5 runs of 40 opens, on a 1 MB database). The window then takes 128 to 173 ms to show the chat (the shell table below).

### Decision: keep Node

- Verdict: no difference beyond the noise for a helper kept running, and worse for a helper started per open. Both paths run the same SQLite, the query is an index lookup that returns at most 81 KB, and the parse that follows happens in Node either way.
- The read is 0.16 ms of a 1.0 ms request of a 128 to 173 ms open. There is nothing here for Jacob to notice.
- Preparing the statements once is 0.01 to 0.03 ms faster in both sessions, with overlapping ranges. It is not worth a change on its own.
- Not measured: a database far larger than 718 MB, a chat with thousands of rows read whole, and a cold disk cache (every run here read a file the machine already had in memory).

## Local server memory

The local server is one Node process that holds every route, the database and the engine sessions: 593 source files and about 126,000 lines under `server/` (read in code). The measurement starts the repository's fixture server with the fake engine, reads the memory of its process tree five seconds after it is up, has six dogs answer 150 messages between them (120 in one long chat, 6 in each of five others), and reads it again five seconds after the last answer.

Measured. 5 runs, each with a fresh server and a fresh data folder. Memory is read from `/proc/*/smaps_rollup` for the server and every process under it.

| When | Processes | Shared pages counted once (PSS) | Resident (RSS) |
| --- | ---: | ---: | ---: |
| A bare Node process doing nothing, for scale | 1 | 26 MB (26 to 26) | 45 MB (45 to 45) |
| Fresh server, idle | 1 | 210 MB (208 to 212) | 247 MB (246 to 249) |
| While the dogs answer, at the tree's largest | up to 10 | 535 MB (517 to 562) | 956 MB (931 to 1,024) |
| Idle again, five seconds after the last answer | 7 | 511 MB (507 to 512) | 838 MB (834 to 840) |
| Of that, the server process alone | 1 | 273 MB (269 to 274) | 322 MB (319 to 323) |

The other six processes after the chats are the fake engine, one per dog, at 39 to 41 MB each (first run). The server's own peak resident memory was 324 MB (321 to 325). The 150 answers took 12.3 s (12.1 to 13.0).

The same measurement before the machine restarted, 5 runs again, gave 211 MB for the fresh server, 548 MB at the largest and 512 MB idle afterwards. It did not read the server alone or the bare Node process.

Limits of this measurement:

- The fixture server runs the TypeScript sources through Node's type stripping (`scripts/control-laterdog.ts`). The packaged app runs a bundled build of the same code inside the shell's own Node. That was not measured.
- The fake engine stands in for the engines' own command-line programs, which are far larger than it and are not part of later.dog.
- A real home's database is hundreds of megabytes; this one was 1 MB.

### Decision: keep Node

- The server is one process: 210 MB idle, of which a bare Node process accounts for 26 MB, and 273 MB with six dogs' chats behind it. None of the seams measured here lives in that memory in a way a helper could lift out. The chat read keeps 60 MB in Node with or without a helper, and the save runs in the home's runtime, not in this process.
- A helper is a further process. The ones measured here were 4.4 MB (chat reader), 8 to 52 MB (save step) and 139 MB (save step on the crowded home), each beside an unchanged server.
- Of the 301 MB the tree grows by once six dogs have worked, 63 MB is the server and 238 MB is the six engine processes. Engines are command-line programs later.dog starts, not code it could move to Rust.
- Taking the 210 MB down would mean writing the server again in another language. That is a rewrite of 126,000 lines, not a seam, and nothing here measures what it would save.

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

- Linux only, without a graphics card. On a Mac the system webview is a different build of the same engine. Not measured; the commands are under [To measure on the Mac](#to-measure-on-the-mac).
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
| Universal build on a Mac | Two builds, `aarch64-apple-darwin` and `x86_64-apple-darwin`, kept apart under `dist-native/${arch}` as today's native pieces are, or joined with `lipo`. Only arm64 is released today. Not built. | The one file. |
| Into the desktop bundle | A line under `extraResources` in `electron-builder.yml` from `dist-native/${arch}`, the way the computer-use driver ships. electron-builder signs it with the app. | Bundled by Vite like any asset. No signing. |
| Into the home image | `deploy/laterdog/home/Dockerfile` copies only the `runtime/` folder onto a `node:24-bookworm-slim` base. A binary needs a build stage or a pinned download, and has to be built against that base's C library, which is older than this machine's. | Does not apply. |
| Where it is built | There are no build workflows in this checkout; releases are made on Jacob's Mac (`docs/laterdog/releasing.md`). The Mac would need a Rust toolchain, or the binary would be built elsewhere and pinned by checksum. | The same toolchain question, once. |

## Migration and rollback

| Option | Getting there | Getting back |
| --- | --- | --- |
| Improved Node path | An ordinary pull request with tests. Pull request #160 is this. | Revert the commit. The saved format does not change. |
| One Rust component | Ship the binary switched off behind a setting. Run it in shadow first: Node does the work, Rust does it too, and any difference is logged. Then switch it on, falling back to the Node path on a missing binary, a non-zero exit, output that does not parse, or a timeout. The Node path stays and stays tested. | Switch the setting off. The Node path is still there, and the manifest and the database are the same format under both. |
| New shell | A parallel app until it matches the table above, then one release of today's app that updates into it. | None once people have updated. A newer release of the new shell is the only fix. |

## To measure on the Mac

Nothing below has been run on a Mac. The scripts were written and run on Linux. Their macOS paths were added by reading only: memory comes from `ps` there, as resident memory, because macOS has no count of shared pages; and the shell prototype builds its window on the system webview through a branch that has never been compiled (checking it from Linux stops in a dependency that needs Apple's compiler). Expect the first run of steps 4 to 8 to need a fix.

Disk: the Rust toolchain was 692 MB on Linux and the four builds 677 MB. The Mac had about 3.4 GB free on 2026-11-11, so the fixtures below are smaller than the Linux ones. Compare Mac rows with each other, not with the Linux tables.

1. What is installed. Nothing is built or changed. This answers whether Xcode is there, whether the app is universal, and its size on disk.

   ```sh
   xcode-select -p; xcodebuild -version
   security find-identity -v -p codesigning
   du -sh /Applications/later.dog.app
   lipo -archs /Applications/later.dog.app/Contents/MacOS/later.dog
   codesign -dv --verbose=2 /Applications/later.dog.app 2>&1 | grep -E "Identifier|TeamIdentifier|flags"
   ```

2. Memory of the running app's process tree, once idle and once after opening a long chat. It reads process sizes only. Engines started from the `PATH` are not counted.

   ```sh
   ps -axo rss=,command= | awk '/later\.dog\.app\/Contents/ { kb += $1; n += 1 } END { printf "%d processes, %.0f MB resident\n", n, kb / 1024 }'
   ```

3. The toolchain and the builds. This installs Rust in Jacob's home folder, so it is his call.

   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
   . "$HOME/.cargo/env"
   rustup target add wasm32-unknown-unknown
   cd prototypes/rust-seam
   (cd save-walk && cargo build --release)
   (cd chat-open && cargo build --release)
   (cd markdown-wasm && cargo build --release --target wasm32-unknown-unknown)
   (cd shell/wry-shell && cargo build --release)
   mkdir -p ~/rust-mac
   ```

4. Markdown, in Node on the Mac. The parse inside the app's window stays unmeasured.

   ```sh
   node markdown-wasm/bench-markdown.mjs --out ~/rust-mac/markdown.json
   ```

5. The save on the Mac's file system, with a 200 MB database (about 600 MB of fixture, and 200 MB more while a copy exists).

   ```sh
   node save-walk/make-home.mjs build ~/rust-mac/home --db-mb 200
   node save-walk/bench-save.mjs --root ~/rust-mac/home --runs 7 --out ~/rust-mac/save.json
   /usr/bin/time -l save-walk/target/release/save-walk save ~/rust-mac/home ~/rust-mac/save-bench-work/previous.json 4 > /dev/null
   ```

   The Rust child reports its own peak memory as 0 on a Mac, because it reads `/proc`. The last line gives it instead.

6. Reading a chat, with a 200 MB database.

   ```sh
   node chat-open/make-chat-db.mjs ~/rust-mac/chat/messages.db --db-mb 200
   node chat-open/bench-chat-open.mjs --db ~/rust-mac/chat/messages.db --runs 7 --out ~/rust-mac/chat-open.json
   ```

7. The local server's memory, on a fixture server. The renderer is built into a folder of its own, so a later.dog Dev app running this checkout is not disturbed.

   ```sh
   cd ../..
   pnpm exec vite build --outDir ~/rust-mac/dist
   node prototypes/rust-seam/server-memory/bench-server.mjs --dist ~/rust-mac/dist --runs 5 --out ~/rust-mac/server-memory.json
   ```

8. The two shells. Windows open on the Mac's screen for about a minute each run.

   ```sh
   node prototypes/rust-seam/shell/bench-shell.mjs --dist ~/rust-mac/dist --electron node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --electron-folder node_modules/electron/dist/Electron.app --wry prototypes/rust-seam/shell/wry-shell/target/release/wry-shell --runs 7 --out ~/rust-mac/shell.json
   ```

   On a Mac the system webview keeps its data in one place per program, so the Rust shell's launches after the first do not start from an empty profile the way they do on Linux.

9. Clean up: `rm -rf ~/rust-mac prototypes/rust-seam/*/target prototypes/rust-seam/shell/wry-shell/target`, and `rustup self uninstall` if the toolchain should go.

Not covered by any command: whether macOS keeps the Accessibility and Screen Recording grants for an app rebuilt with a different shell under the same identifier. That needs a signed build of such an app.

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
cd ../..
pnpm exec vite build --outDir ~/rust-lane/dist
node prototypes/rust-seam/server-memory/bench-server.mjs --dist ~/rust-lane/dist --runs 5
node prototypes/rust-seam/shell/bench-shell.mjs --dist ~/rust-lane/dist --electron node_modules/electron/dist/electron --wry prototypes/rust-seam/shell/wry-shell/target/release/wry-shell --runs 7
```

Timed runs were each started as `flock -x ~/heavy.lock node ...`, and builds as `flock -s ~/heavy.lock cargo ...`.

The raw results of the runs reported here are in [`assets/rust-seams/`](assets/rust-seams/).

The Rust sources stay under `prototypes/rust-seam/` as measurement tools. They are not built or shipped by any package script, and each crate's `Cargo.lock` pins the versions that were measured. Build output, WebAssembly files and fixture databases are ignored by `prototypes/rust-seam/.gitignore`; the largest file committed there is a 69 KB lock file.

`scripts/no-comments.test.ts` reads every file under `prototypes/rust-seam/` except the lock files Cargo writes, and has a test that says so. It has tests that a Rust comment is caught while strings, raw strings, characters and lifetimes are left alone, and that a comment in a Cargo manifest is caught, whole-line or at the end of a line, while a `#` inside a string is left alone.

## Still open

- Every number on a Mac. The commands are under [To measure on the Mac](#to-measure-on-the-mac); none has been run there, and the shell prototype's macOS branch has never been compiled.
- The markdown parse inside the app's window, on any platform. It was measured in Node.
- The packaged app's own memory: the window was a bare Electron window and the server ran from sources.
- Whether Jacob's Mac has Xcode (step 1 of the Mac list answers it), and whether the Mac keeps permission grants for a rebuilt app.
- No Rust component was packaged, signed or notarised, and no universal build was made.
- The buffer sizing above, as its own change with a test.
