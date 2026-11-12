# Native Mac app (Rust on AppKit), 2026-11-12

A second desktop app that is only a screen onto a later.dog home: a Rust core with no I/O
(`native/core`) and a Mac window drawn with AppKit from Rust (`native/mac`). No web view and no
Node runtime. It is built beside the released app and replaces nothing.

This supersedes the "clean-sheet shell" row of [the Rust seams note](rust-seams.md). That row
measured a small shell around the same web renderer and a bundled Node server, on Linux, so the
memory it measured was the renderer's and the server's.

## What it does today

- Lists a home's dogs in the home's order with their faces (the eight dog breeds, drawn from the
  desktop's breed shapes), last line, time and unread dot.
- Shows a dog's chat as bubbles with day lines; tool steps fold into one line; older messages load
  when the top is reached.
- Follows the home's event stream, reconnects (500 ms doubling to 10 s, stale after 40 s) and
  resumes from its last frame, or reloads when the home cannot resume.
- Sends through its own outbox: one lane per chat, held with its words while the home sleeps or
  cannot be reached, five tries for a server fault, Not sent with the words kept on a refusal,
  Send again with the same id. Unsent messages are saved and delivered after a relaunch.
- Tells the home a chat was read.
- `--snapshot <png>` draws its own window to a file and `--tree` prints its structure, so it can be
  checked without capturing the screen; `--dump` prints what it would show as JSON.

## What it does not do

Sign-in to a real home, group chats, cards and approvals, Markdown, attachments, dictation and
voice, settings, accounts and usage, search, the model menu, notifications, updates, signing and
notarising. Search, +, More, the microphone, voice and the model control are drawn and inert. The
header has no blur and the pills no shadow; the eight non-dog avatar shapes draw a letter; faces do
not blink. Light and dark follow the stylesheet's values, checked by eye.

## Checks

On this Mac (Apple silicon, 8 GB, macOS 26.3), commit named in the pull request:

- `cargo test`: 72 pass (69 in the core; 3 drive the app's network code against a fake home that
  refuses, answers 503, cuts the stream mid-frame and resumes).
- Against an isolated fake-engine fixture: the dog list and a chat load; a message sent through the
  app is answered and the reply arrives by the event stream; a message sent to a dead address is
  saved, and the next launch delivers it once with the same id; older history loads to 480
  messages in order with no repeats; selecting a dog clears its unread flag at the home.

## Memory and idle work against the web renderer

Same fixture for both: 80 dogs, one chat of 240 messages selected. Five runs each, alternating.
Scripts and raw rows: [assets/native-desktop](assets/native-desktop).

- **Web renderer:** this branch's production renderer build in a bare Electron window
  (`shell.cjs`), with none of the app's main-process code and no local server. That leaves out
  memory the released app has, so it favours the web renderer.
- **Native:** the release build of `native/mac`.
- **Memory** is physical footprint (`footprint <pid>`), summed over the process tree, 12 s after
  the chat was ready. **Idle work** is CPU time used over the next 10 s, as a share of one core.

| | Web renderer in Electron | Native |
| --- | ---: | ---: |
| Processes | 5 | 1 |
| Idle memory, median (lowest to highest) | 375 MB (360 to 405) | 29 MB (27 to 29) |
| Idle work over 10 s, median | 45 % of a core (44 to 63) | 0.0 % |
| App on disk | 249 MB download (0.3.46 release) | 2.2 MB binary |

What these numbers are not:

- **Not a quiet machine.** Other programs on this Mac were using more than two cores throughout,
  and the load average was 4 to 13 during the runs. Memory is not sensitive to that; the idle work
  figure is one reading per run on a busy machine and has not been explained (the renderer may
  still have been settling), so treat it as a lead, not a result.
- **Not a launch time.** Time from launch to a usable chat is not reported: the two apps were
  timed at different loads (web renderer 2.8 to 3.8 s at load 4; native 3.4 to 6.8 s at load 20 or
  more, against 0.7 to 2.0 s on an earlier, also loaded, run). It needs a quiet machine.
- **Not feature parity.** The native app draws far less than the renderer does (see above), and
  each missing feature will add memory.
- Not measured: typing latency, chat switching, scrolling, streaming, peak memory under work, and
  the released app's whole process tree with its local server.

## Why AppKit from Rust

The Mac view was first planned on a cross-platform native kit whose Mac host is Swift. Its Rust
half built here; its Swift half needs a newer macOS SDK than this Mac's command line tools carry,
and full Xcode was ruled out. Drawing with AppKit from Rust needs only `cargo`.

## Next

Sign-in to a real home, then the pieces a person uses daily in order: cards and approvals,
Markdown, group chats, the work state line and exchange rows, settings and accounts. Then the
measurements above on a quiet machine, and signing.
