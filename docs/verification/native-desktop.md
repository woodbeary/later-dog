# Native Mac app (Rust on AppKit), 2026-11-12

A second desktop app that is only a screen onto a later.dog home: a Rust core with no I/O
(`native/core`) and a Mac window drawn with AppKit from Rust (`native/mac`). No web view and no
Node runtime. It is built beside the released app and replaces nothing.

This supersedes the "clean-sheet shell" row of [the Rust seams note](rust-seams.md). That row
measured a small shell around the same web renderer and a bundled Node server, on Linux, so the
memory it measured was the renderer's and the server's.

## What it does today

- Lists a home's dogs in the home's order with their faces (the eight dog breeds, drawn from the
  desktop's breed shapes), last line, time and unread dot. When the home has sections, the list is
  grouped under a header per section with its count, then Unassigned for the rest. A More unreads
  pill appears above or below the list when an unread dog is out of view and scrolls to it.
- Shows a dog's chat as bubbles with day lines; tool steps fold into one line; older messages load
  when the top is reached. The chat scrolls under a translucent blurred bar behind the header.
- Shows dog replies as Markdown: paragraphs, bold, italic, code spans, headings, lists, quotes,
  rules, fenced and indented code in a box with its language, line count, Wrap, Save and Copy and
  sideways scrolling, and tables as aligned monospace text. Links open in the default browser only
  for web and mail addresses. Raw HTML is shown as text. Text stays selectable. The list's preview
  line reads a reply as plain words.
- Shows what a dog is doing in the desktop's words: one line beside the header pill, and as the
  dog's second line in the list when it is waiting on another dog, waiting for usage or the
  computer, reconnecting to the engine or stopped.
- Shows a message between dogs that carries its record as one quiet centred row (Messaged or
  Message from, the other dog's face and name, the gist and its state); a click opens who asked
  whom, the request and the reply. A line without a record folds into View work.
- Follows the home's event stream, reconnects (500 ms doubling to 10 s, stale after 40 s) and
  resumes from its last frame, or reloads when the home cannot resume.
- Sends through its own outbox: one lane per chat, held with its words while the home sleeps or
  cannot be reached, five tries for a server fault, Not sent with the words kept on a refusal,
  Send again with the same id. Unsent messages are saved and delivered after a relaunch.
- Tells the home a chat was read.
- `--snapshot <png>` draws its own window to a file and `--tree` prints its structure, so it can be
  checked without capturing the screen; `--expand` opens every row between dogs; `--dump` prints
  what it would show as JSON.

## What it does not do

Sign-in to a real home, group chats, cards and approvals, attachments, dictation and voice,
settings, accounts and usage, search, the model menu, notifications, updates, signing and
notarising. Search, +, More, the microphone, voice and the model control are drawn and inert.

Against the desktop, these are drawn differently or not at all:

- Markdown: no syntax colours in code, no math, no images (an image shows as its link text),
  no mentions, no spoilers (`~~text~~` stays as typed), no reference links, tables are plain
  monospace text rather than a table, and the code header icons are the system's. Selection does
  not run across a code block. Link and Save were checked by reading the code path, not by
  clicking.
- Rows between dogs: several messages to one dog in a turn are not gathered into one row with a
  count, failed requests have no warning pill, the row opens its details instead of the exchange
  chat, the results of a finished request are not listed, and a request text the dog received is
  hidden only when its record was folded into the row.
- Work state: the line says nothing when the home sends no work state, even if the dog waits for
  teammates; the reset time is formatted when the list is drawn and does not tick.
- List: section headers cannot be collapsed, reordered or renamed, and pinned dogs are not set
  apart. The header bar's blur is drawn by the system, so `--snapshot` shows its tint and fade but
  not the blur itself.
- The More unreads pill's shadow is set by eye, the header pill has no shadow, the eight non-dog
  avatar shapes draw a letter, and faces do not blink. Light and dark follow the stylesheet's
  values, checked by eye.

## Checks

On this Mac (Apple silicon, 8 GB, macOS 26.3), commit named in the pull request:

- `cargo test`: 111 pass (108 in the core, among them the Markdown parser, work-state wording,
  exchange rows, section headers and unread counts; 3 drive the app's network code against a fake
  home that refuses, answers 503, cuts the stream mid-frame and resumes).
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
- **Not feature parity.** The native app draws far less than the renderer does (see above), and
  each missing feature will add memory.
- Not measured: the first launch of a new unsigned binary (the system checks it for about a second before it runs), typing latency, chat switching, scrolling, streaming, peak memory under work, and
  the released app's whole process tree with its local server.

## Launch to a usable chat

Same fixture and the same two builds. Seven runs each, alternating, after one discarded warm-up,
timed by wall clock from the moment the process is started (`launch.sh`, raw rows in
`launch-2026-11-12.tsv`). The web renderer's time ends when the selected chat's message box is
ready; the native app's ends when the selected chat has been drawn and written to a PNG, which is
a little more than the web renderer is charged for.

| | Web renderer in Electron | Native |
| --- | ---: | ---: |
| Launch to a usable chat, median (lowest to highest) | 805 ms (745 to 903) | 254 ms (250 to 307) |
| Of that, inside the app after its own code starts | 584 ms | 182 ms |

The load average was 9 to 12 during these runs (file indexing by the system). The runs alternate
and each app's spread is small, so the comparison holds; the absolute times would be lower on an
idle machine. As above, the web renderer here has none of the released app's main-process code or
local server, and the native app draws far less than the renderer.

## After Markdown, work state, rows between dogs and sections

Release build of `native/mac`, native only, on an isolated fake-engine fixture with 33 dogs in
two sections plus Unassigned and one chat of 151 messages (101 of them text) selected. Five runs
after one discarded warm-up (`native.sh`, raw rows in `native-2026-11-12-step7.tsv`). Launch is
timed by wall clock from process start until the selected chat is drawn and written to a PNG;
memory is physical footprint 12 s after a separate launch with the window open, and idle work is
CPU time over the next 10 s.

| | Median (lowest to highest) |
| --- | ---: |
| Launch to the chat drawn | 403 ms (384 to 422) |
| Of that, inside the app after its own code starts | 267 ms (252 to 296) |
| Idle memory | 35 MB (34 to 35) |
| Idle work over 10 s | 0.0 % of a core (0.0 to 0.1) |

The load average was 12 to 19 during these runs (other programs on the Mac), so the launch times
are high. This fixture is not the one in the tables above (33 dogs and 151 messages there against
80 and 240), so the rows are not a before-and-after comparison.

## Why AppKit from Rust

The Mac view was first planned on a cross-platform native kit whose Mac host is Swift. Its Rust
half built here; its Swift half needs a newer macOS SDK than this Mac's command line tools carry,
and full Xcode was ruled out. Drawing with AppKit from Rust needs only `cargo`.

## Next

Sign-in to a real home, then the pieces a person uses daily in order: cards and approvals,
group chats, settings and accounts. Then the
measurements above on a quiet machine, and signing.
