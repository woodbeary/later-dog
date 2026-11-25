# Desktop performance, measured against a fixture

`scripts/desktop-perf.ts` measures the real renderer: the production build from
`pnpm exec vite build`, served by a fake-engine fixture server, opened in a
headless Chrome. It seeds one long chat and several short ones through the same
send route the app uses, then records how long the things a person does take.
Nothing here touches the user's app or data.

## Run

```sh
pnpm exec vite build
node --experimental-strip-types scripts/desktop-perf.ts \
  --playwright /path/outside/this/checkout \
  --label after --out .laterdog-scratch/desktop-perf/after.json
```

`--playwright` names a folder holding `node_modules/playwright-core`; keep it
outside the checkout so it never joins the lockfile. `--browser` picks the
Chrome binary (default `/usr/bin/chromium`). `--dist` serves another build,
`--long-turns`, `--other-dogs`, `--other-turns`, `--cold-runs` and `--switches`
size the run. The fixture serves the build because the launcher passes
`LATERDOG_TEST_STATIC_DIR` through to the server as its static folder.

`--loads-only` records fresh-profile loads and fixture HTTP reads without the
interaction passes. `--http-runs N` (default 20) sets the HTTP samples per route.
Each route gets one discarded warm-up, then health, dog-list and 200-message
transcript reads alternate their order. The report keeps every sample, status,
body size, response-header duration and complete-body duration. Non-success
responses and redirects fail the run. These are loopback HTTP timings, excluding
TLS, the edge, container wakes and engine generation.

Loads retain `composerReadyMs` for textarea insertion and add
`uncoveredComposerMs`: the first observed visible textarea after the launch
cover is gone. `composerCoverWaitMs` is the time between insertion and that
observation. The page's own mutation observer timestamps both events, so a
late host read does not add to the result. This is DOM readiness, not a GPU
presentation timestamp. The raw per-load samples are kept. A new browser profile is not an OS cold launch;
packaged desktop launch is measured separately by the launch timeline.

Two modes check behaviour instead of timing it, and can be combined in one
run:

- `--sidebar-rows` (best with `--other-dogs 79 --other-turns 2`) gives every
  second dog a title, then records the height each kind of row holds while its
  contents are not drawn against its height when drawn, in the list and in the
  icon rail, and whether one click on the "more unread below" pill lands an
  unread row near the end of the list in view. `--shots DIR` photographs the
  landing.
- `--sidebar-shots DIR` (with `--other-dogs 79 --other-turns 2`) marks every
  third dog unread, scrolls the sidebar to its middle, moves keyboard focus to
  an unread row with Tab, and photographs the sidebar and a close-up of the
  focused row, in the list and in the icon rail, light and dark, at three
  device pixels to one. It also records whether the focus ring is on and how
  far any badge reaches past its row.
- `--kept` writes a draft in two chats and checks each is still there after
  switching and after a reload, that the reload opens the same chat, that the
  accessibility tree has a named button for every dog's row whether or not
  its contents are drawn, and that Tab reaches every row with a focus ring and
  in view, and Enter opens it. It then has a dog that is not open take a turn
  and checks that dog's row shows the working dots and says "Working" while it
  replies, and afterwards shows the unread dot, says "Unread", previews the
  reply and is counted with the unread rows, while the open chat stays open.

- `--one-dog-streams` opens the long chat and lets one dog stream a long reply
  three characters at a time, first a dog that is not open and then the open
  one. It counts the components that redraw and where they sit (sidebar rows,
  the rest of the sidebar, the open transcript, the rest of the open chat, the
  rest of the app), apart for each store change and for each time the reply
  grows on screen, and then times key press to frame while typing in the open
  message box with no dog streaming, with another dog streaming, and with the
  open dog streaming.

Two more modes help find a cause rather than a number:

- `--names` with an unminified build (`pnpm exec vite build --minify false
  --outDir DIR`, then `--dist DIR`) adds the thirty components that redrew most
  in each step.
- `--landing-only` runs only the landing measures below, `--landing-reps N`
  (default 3) sets how many times each case repeats.
- `--profile-switch` prints where the time goes while switching chats, and
  `--probe-remove` prints any single DOM removal that took over 1.5 ms.

## What it records

| Step | How |
|---|---|
| Load | First paint, message-box insertion and visible uncovered message box, each in a fresh browser profile |
| Home HTTP | Health, dog list and long transcript reads from the isolated fixture; response headers and full body timed separately, with all raw samples |
| Chat switching | Click a sidebar row; stop when the chat's message box and a row of its transcript are on screen for two frames |
| Typing | 119 keys at 35 ms; key press to the second frame after it |
| Scrolling | 90 wheel steps through the long chat |
| A streamed reply | Enter to the person's own bubble, and to the first words of the reply; frames and long tasks until the dog settles |
| Other dogs working | Four other dogs take a streamed turn while an idle chat is open |
| Redraws | A second pass counts React commits and components that redrew, through the commit hook |
| Landing | A reply that finishes lands in the open long chat, short and long, once while following the bottom and once scrolled up 1,500 px. Longest main-thread task and blocking time (tasks over 50 ms, the part past 50 ms) from a Chrome trace, from 50 ms before the reply's frame arrives to 500 ms after its bubble is first seen; rows above the new bubble that move (against the first row that is still there, and against the viewport), plus Chrome's layout-shift entries |
| Redraw causes | Each commit in a working turn is filed under what ran in the 150 ms before it: a `native.run.updated` frame, a `message.patch`, a new `message`, any other server frame (`workAndRuntime`), a timer, the person's input, an answered request, or nothing recognised (`unattributed`). A commit with more than one cause is its own `mixed:` entry and also counted under each cause in `causeTotals` as `withOthers` |
| Settings open | The working-turn pass again, with Settings open (Ctrl+,) over the long chat and the same scripted reply, sent through the API |
| Memory | JS heap after a collection at idle and after the run, DOM nodes, and resident memory of the server tree and the headless Chrome tree at idle, at its highest during the timed pass (sampled every second) and at the end |

The browser tree is not the packaged Electron app's process tree. RSS can count
shared pages more than once. The soak mode's renderer reading uses Linux
anonymous memory plus swap where available, with RSS as its fallback on other
platforms. Each report records Node, CPU, core count, RAM, OS and load average.

The fake engine streams a reply in pieces when `FAKE_CLAUDE_STREAM_FILE` names
a JSON file `{ "everyMs": 30, "chars": 10 }`, and reads scripted replies from
`FAKE_CLAUDE_REPLIES_FILE` when the list is too long for the environment.

## The budget check

`--budget [file]` turns the script into a check. It runs the parts of the script the budget's measures come from, prints one table (measure, budget, target, measured, distance to target, verdict) and exits 0 only if every line holds. The default file is `scripts/desktop-perf.budget.json`.

```sh
pnpm exec vite build
node --experimental-strip-types scripts/desktop-perf.ts --playwright /opt/node-tools \
  --browser /opt/pw-browsers/chromium --label check --out .laterdog-scratch/desktop-perf/check.json --budget
```

- `--budget-quick` runs only the redraw counts and the landing measures (no cold loads, no timed pass) and lists the lines it skipped. It is the short subset: 90 s against 135 s for the full check on the computer below. It does not cover the frame, task and open-time lines of the timed pass, so it does not qualify a change that could slow typing or switching.
- `--reference result.json` takes the reference of each ratio line (the calibration) from a saved result instead of this invocation.
- The comparator is `scripts/desktop-perf-budget.ts` (pure, with tests); the measures a budget can name, and where each is read from the result, are in `scripts/desktop-perf-measures.ts`.

### Two kinds of line

- **Count lines** (commits, components redrawn, tasks over 50 ms, frames over 25 ms, pixels a row moves) compare directly: the line holds when the measured value is at most `budget` plus the optional `tolerance`. The table shows the tolerance as `(+n)`.
- **Ratio lines** (durations) compare the measured milliseconds divided by the same invocation's calibration, a fixed CPU workload the script times on the same computer (median of five, about 190 ms here; 181 to 211 across the runs here), so a slower computer scales both. A line holds when the ratio is at most `budget`.

Each line also carries a `target`, where the program is heading (a work update redraws only its work row; no task over 50 ms; nothing above a landing reply moves; no frame over 25 ms while typing with a dog working). The table shows how far the run is from it, so a passing run still says how far there is to go. A measure the budget names that the run did not produce fails as `not measured`; it never passes silently.

### Setting the numbers

Budgets are the highest value seen across A1's three baseline runs and this package's seven full runs (one probe, three to set the spread, three that passed) of the same script on the same build, plus a tolerance only where the spread showed one:

| Line | Seen | Budget (tolerance) | Target |
|---|---|---|---|
| Working turn: commits | 24 to 27 | 27 (+1) | 1 |
| Working turn: components redrawn | 5,017 to 5,161 | 5,020 (+150) | 45 |
| Settings open: commits / components | 18 to 22 / 5,106 to 5,328 | 22 / 5,330 | 1 / 45 |
| Four other dogs: commits / components | 36 to 51 / 690 to 850 | 51 / 850 | 0 |
| Typing 119 keys: commits / components | 245 to 247 / 2,775 to 2,779 | 247 (+2) / 2,780 (+20) | 0 |
| Tasks over 50 ms (working, Settings open, other dogs, landing) | 0 | 0 | 0 |
| Working turn: frames over 25 ms | 0 to 3 | 3 | 0 |
| Settings open: frames over 25 ms | 18 to 27 | 27 | 0 |
| Typing, no dog working: frames over 25 ms | 0 in nine runs, 1 in the tenth (a slow run, calibration 239 ms) | 2 | 0 |
| Reply landing, rows above moved: scrolled up / following | 0 and 55.5 in every run (A1's 48 and 103.5 not reproduced) | 0 / 55.5 (+0.5) | 0 |
| Reply landing, rows in view moved, scrolled up | 0 in every run (A1's 48 not reproduced) | 0 | 0 |
| Key press to frame p95 / calibration | 0.15 to 0.18 | 0.30 | 0.10 |
| Open the long chat p50 / calibration | 0.88 to 1.02 | 1.4 | 0.5 |
| Open a short chat p50 / calibration | 0.27 to 0.30 | 0.5 | 0.2 |
| Landing longest task / calibration | 0.17 to 0.25 | 0.4 | 0.1 |

The working turn redraws 5,017 to 5,019 components when it takes 26 commits and 5,160 when a 27th small commit joins; the +150 covers that, and is small against the 475-component commits a regression adds. The landing pixel lines are 0 px (scrolled up, rows above and rows in view) and 55.5 px (following, rows above). Those are what every later run measured: the nine runs of the unchanged build in this package, and three more on a third computer, twice with this script and once with A1's own script at 5519707 against the same build, each with all cases agreeing. A1's 48 px and 103.5 px (below, marked) were seen only in A1's own three runs, were not reproduced in those 13 later runs on two other computers with either script version, are unexplained, and are superseded by 0 px and 55.5 px. The 55.5 px when following is the one row the full 120-row transcript window drops from the top (`rowsRemovedFromTop` is 1 in those cases): the 118 rows above move by that row's height. The scrolled-up lines have no tolerance because every repetition was exactly 0; the following line has +0.5 because rows in view moved 8 or 8.3 px between repetitions, so a sub-pixel jitter is seen, while the 55.5 itself never moved.

### Left out

- Worst frame with Settings open: 67 to 150 ms across runs, one dropped frame in a short window. The frames-over-25-ms line covers it.
- Load (first paint, composer ready), own bubble, first reply text: they depend on process start and on the fake engine's delay, and moved by 20% or more between runs.
- Memory (heap, resident sets): measured per run, but the browser tree moves by 30 MB between identical runs.
- Idle main-thread busy time, 16 to 19 ms per 3 s: too small a number to compare.
- Switching and scrolling redraw counts and long tasks (112 commits, 31,461 to 32,535 components, a spread of 3%): they are in the result file; not budgeted yet because no package is aimed at them.
- Typing with a dog working (`--one-dog-streams`): the target "no frame over 25 ms" exists, but that mode is not part of the default run, so there is no line for it yet.
- Any run on a computer other than this one, the Mac app, a real engine.

### Tightening

`scripts/desktop-perf-budget-file.test.ts` fails when a line is looser than the same line in the file on `origin/main` (budget plus tolerance; a dropped line or a changed kind also fails; the test skips while the file is not on `origin/main` yet) and when the budget names a measure the script cannot produce. A package that improves a number lowers that line's `budget` in the same change and shows the run.

## Baseline, 2026-11-25 (replaces the 2026-11-10 tables as the current baseline)

Fixture numbers on Linux x64 (4 vCPU, 16 GB cloud computer) in headless Chrome. Not the Mac app: its launch, its process tree and a sleeping Cloud home are not in them. The 2026-11-10 tables below were measured before two later commits and never re-measured; this section replaces them.

App measured: main 6bc6bb7 (`origin/main` when the runs were made). The script is the version on branch `refine/a1-desktop-baseline`, which changes only `scripts/desktop-perf.ts`. Production build from `pnpm exec vite build` at the same tree. Three full runs, one after another on an otherwise idle computer, 00:46 to 00:53 UTC:

```sh
node --experimental-strip-types scripts/desktop-perf.ts --playwright /opt/node-tools \
  --browser /opt/pw-browsers/chromium --label baseline-N --out .laterdog-scratch/desktop-perf/baseline-N.json
```

Default sizes: a 240-message long chat (120 turns), five other dogs with 6 turns each, 5 cold loads, 8 switches, 3 landing repetitions per case. Median and range are over the three runs. An earlier set of three runs (before the landing-shift measure was fixed) was discarded, and the computer restarted in between; the machine was faster after the restart (open the long chat 154 ms then, 134 ms now), so only the later set is reported and numbers here should not be compared with any other session's.

| Measure | Median | Range (3 runs) |
|---|---|---|
| Load: first paint, message box ready (p50 of 5 cold loads) | 164 ms, 250 ms | 164 to 168, 233 to 253 |
| Open the long chat, p50 / slowest of 8 | 134 / 139 ms | 126 to 139 / 132 to 169 |
| Open a short chat, p50 | 45 ms | 38 to 52 |
| Long tasks across 16 switches, worst frame | 0 (3 in one run), 67 ms | 0 to 3, 67 to 100 |
| Key press to frame, p50 / p95 | 25 / 32 ms | 25 to 25 / 32 to 33 |
| Own bubble after Enter | 18 ms | 16 to 20 |
| First reply text after Enter | 1,022 ms | 1,018 to 1,046 |
| Working turn: slow frames (over 25 ms) of frames | 1 of 98 | 0 to 2 of 97 to 98 |
| Working turn: commits / components redrawn | 26 / 5,018 | 24 to 26 / 5,017 to 5,019 |
| Working turn with Settings open: slow frames of frames | 22 of 22 | 22 to 27 of 22 to 27 |
| Working turn with Settings open: worst frame | 83 ms | 67 to 83 |
| Working turn with Settings open: commits / components redrawn | 22 / 5,326 | 19 to 22 / 5,111 to 5,328 |
| Four other dogs working: commits / components redrawn | 45 / 770 | 43 to 51 / 770 to 850 |
| Switching 16 times: commits / components redrawn | 112 / 31,811 | 112 to 113 / 31,555 to 32,535 |
| Typing 119 keys: commits / components redrawn | 247 / 2,779 | 245 to 247 / 2,775 to 2,779 |
| Main thread busy while idle, per 3 s | 16 ms | 15 to 19 |
| JS heap idle, after the run | 13.2 MB, 27.1 MB | 13.1 to 13.3, 27.1 to 27.2 |
| Browser tree resident, highest | 1,189 MB | 1,182 to 1,211 |
| Server tree resident, highest | 878 MB | 878 to 881 |

### What triggers the redraws of a working turn

Commits in the working turn of the open long chat (medians of three runs; the same turn in the counted pass, 26 commits). A commit with one cause is "alone"; one with several is counted under each in "with others".

| Cause | Alone: commits, components | With others: commits |
|---|---|---|
| `native.run.updated` | 1 (0 to 1), 4 | 7 (7 to 8) |
| Message patches (`message.patch`) | 0 | 2 |
| New messages (`message`) | 0 | 3 |
| Other server frames (`runtime`, `bot` and the like) | 1, 46 | 10 (10 to 11) |
| Timers | 2 (1 to 2), 66 | 2 (2 to 3) |
| The person's input (Enter) | 1, 45 | 0 |
| Answered requests | 0 | 3 |
| Unattributed | 10 (9 to 10), 4,754 | 0 |

Most of the cost is one kind of commit: about ten commits redraw about 475 components each, which is 4,754 of the 5,018. Each of them came 150 to 400 ms after a recognised frame or key press, and none within 150 ms of anything, so they are not attributed (the entry's `triggers` names the nearest earlier frame). They are probably deferred renders of work a frame started; that was not confirmed. Everything the cause list names is small, about 45 components or fewer per commit. With Settings open the same split holds (7 to 8 unattributed commits, 4,590 to 4,688 components), and the open settings panel makes the commits that a new message shares with other causes about ten times larger (241 to 246 components against 22 to 27 for the same three commits). Four other dogs working: 25 to 30 of 43 to 51 commits and 662 to 730 of 770 to 850 components are unattributed in the same way.

The fixture scripts no tool calls (`FAKE_CLAUDE_TOOL_CALLS` is `[]`), so tool chips and cards, the usual `message.patch` source, are not exercised: the patches here come from the turn's own bookkeeping. Timers are the page's `setTimeout` and `setInterval`; animation frames and CSS animations are not counted as causes. How a commit that several things shared splits between them is not decided; both views are in the result file (`causes` and `causeTotals`).

### When a finished reply lands

Open long chat (120 rows in view of the window), reply of 37 characters or of 791 with a list, a code block and a table (729 px tall). Median and range of the three runs, each the worst or median of 3 repetitions as named. Tracing is on in this window and adds a little cost to every number here.

| | Following the bottom, short | Following the bottom, long | Scrolled up, short | Scrolled up, long |
|---|---|---|---|---|
| Longest task, median of 3 / worst of 3 | 16.1 (15.1 to 17.0) / 17.6 (17.3 to 26.6) ms | 18.2 (15.3 to 20.5) / 21.9 (18.8 to 22.6) ms | 13.6 (13.4 to 16.3) / 15.4 (15.2 to 17.4) ms | 18.9 (18.0 to 20.9) / 22.4 (18.6 to 24.2) ms |
| Blocking time (tasks over 50 ms), tasks over 50 ms | 0 ms, 0 | 0 ms, 0 | 0 ms, 0 | 0 ms, 0 |
| Reply frame to bubble seen | 30 ms (17 to 36) | 44 ms (29 to 48) | 36 ms (30 to 39) | 24 ms (21 to 44) |
| Rows in view that moved, most px (against the viewport) | 8 rows, 8.3 px | 11 rows, 697 px (scrolling to follow) | 4 to 11 rows, 48 px, back to 0 by the end | 4 rows, 48 px, back to 0 by the end |
| Rows above that moved against the first surviving row, most px | 118 rows, 103.5 px | 118 rows, 103.5 px | 68 rows, 48 px | 72 rows, 48 px |
| Scroll position changed | -191 px | 498 px | 48 px | 48 px |
| Chrome layout-shift entries, largest px | 2, 690 | 2, 730 | 1, 885 | 1, 48 |

Reading it (the 48 px and 103.5 px figures in this table and below were seen only in A1's own three runs, were not reproduced afterwards and are superseded by 0 px and 55.5 px; they are kept as recorded):

- No task over 50 ms in any run, so blocking time is 0 in every case. The longest single task is 13 to 27 ms; the long reply costs a few ms more than the short one.
- Following the bottom, rows in view move by about the reply's height because the chat scrolls to follow (697 of 729 px for the long reply); that is the following, not a shift. Scrolled up, the reader's rows jump 48 px for at least one frame and are back where they were at the end, and the scroll position ends 48 px lower. That is the one movement a reader could see; its cause was not identified.
- The rows-above count and the 103.5 px and 48 px figures are the same for the short and the long reply, so the reply does not cause them. Only 0 or 1 rows left the window at the top (`rowsRemovedFromTop`). With a 40-message chat, whose window does not fill, both are 0. What moves them was not found; the window being full (120 rows) is the one difference known.
- Chrome's layout-shift sizes are in the file as reported and are of a different kind (they include the scroll); they are listed for completeness, not as a second opinion.

### Not measured

- The Mac app, a real engine, real tool calls, a live provider, a real screen reader, anything on a slower or busier computer. One computer type, one run set.
- The 80-dog size (`--other-dogs 79 --other-turns 2`) was not run for this baseline.
- Tool chips and cards (see above), reply text arriving in the chat while a turn runs (the desktop shows a reply only once finished, so the streamed pieces are not a user-visible event), and `--sidebar-rows`, `--sidebar-shots` and `--kept`.
- Landing was measured through the API send path, not from typing in the box, with the fake engine delaying the reply about 0.8 s so the person's own bubble is already in place. Layout-shift entries and per-frame row positions are sampled once a frame inside the page, which forces a layout of the rows each frame.
- The full `pnpm gate` has not run for this change.

## Results, 2026-11-10 (superseded by the baseline above)

Both tables below were measured at 456e978, before the review fixes; not
re-measured. Two later commits change what they time: 51157ef (the fill became
one step within each frame) and fa3141c (an off-screen sidebar row is laid out
again and only what is inside it is skipped). The runs were made from the
working tree as it stood at or before 456e978; the exact commit of each run
was not written down.

One cloud computer (Linux x64, 4 vCPU, 12 GB), headless Chrome, a 240-message
chat with code blocks and tables plus five short chats. These are fixture
numbers on Linux. They are not the Mac app: its launch, its process tree and a
sleeping Cloud home are not in them.

Measured at 456e978, before the review fixes; not re-measured.

| Measure | Before | After |
|---|---|---|
| Open the long chat, median | 299 to 342 ms (4 runs) | 118 to 150 ms (5 runs) |
| Open the long chat, slowest of 8 | 342 to 698 ms | 135 to 176 ms |
| Long tasks across 16 switches | 2.9 s, worst frame 367 ms | 0.8 to 1.4 s, worst frame 100 to 150 ms |
| Open a short chat, median | 75 ms | 73 to 99 ms |
| Components redrawn per streamed reply | 11,138 | 4,838 to 4,939 |
| Key press to frame, median and 95th | 24 and 32 ms | 24 and 33 ms |
| Load: first paint, message box ready | 424 ms, 623 ms | 424 ms, 596 to 623 ms |
| Own bubble after Enter | 37 ms | 28 to 44 ms |
| JS heap idle, after the run | 12.8 MB, 25.8 MB | 12.6 MB, 25.8 MB |

Of the four "Before" runs one result file is still on the cloud computer (342
ms median, 698 ms slowest, 2.9 s of long tasks, 11,138 components); the others
could not be read again. The five "After" files are there and match the
column, except that one of them, an unminified build opened twice, has a 154
ms median.

What changed between the columns:

- A chat opens on its newest 30 rows and fills back to the usual 120 a tail at
  a time once it is showing, pausing while the person types
  (`src/hooks/use-transcript-viewport.ts`, `src/lib/transcript-window.ts`).
  After the fill the long chat shows 120 rows and sits 0 px from the bottom.
- A turn's work row redraws when its run changes instead of on every streamed
  piece of a reply (`src/components/NativeWork.tsx`).

### With 80 dogs

The same run with `--other-dogs 79 --other-turns 2`, the size of a busy home.
"Before" here already has the two changes above; the columns compare the next
two. Measured at 456e978, before the review fixes; not re-measured.

| Measure | Before | After |
|---|---|---|
| Main thread busy while idle, per 3 s | 946 ms, a style pass every frame (one separate run, 80-message chat) | 133 and 180 ms, no style passes |
| Typing: frames slower than 25 ms | 123 and 112 of 295 | 38 of 343 and 16 of 383 |
| Key press to frame, median / 95th / worst | 31 / 50 / 101 and 29 / 52 / 73 ms | 24 / 35 / 64 and 23 / 37 / 63 ms |
| Other dogs working: slow frames | 38 of 138 and 30 of 148 | 21 of 158 and 0 of 177 |
| Other dogs working: main thread busy, per 3 s | 2.2 s (second run; the first did not record it) | 2.1 s and 0.6 s |
| A streamed reply: slow frames | 32 of 105 and 30 of 113 | 16 of 131 and 7 of 148 |
| Open the long chat, median | 320 and 339 ms | 267 and 297 ms |
| Load: message box ready | 1,040 and 1,192 ms | 1,071 and 1,115 ms |

Each column is two runs, given in the order they ran, read again on 2026-11-11
from the result files on the cloud computer. An earlier version of this table
gave only the second "After" run for the slow-frame rows.

- Every dog's face ran its own endless blink animation, 80 of them, on screen
  or not, which cost a style pass on every frame. Faces now blink together
  from one clock, only the ones on screen, with a 180 ms one-shot animation
  (`src/lib/dog-blinks.ts`). The run sees a blink within half a second of
  looking for one.
- What is inside a sidebar row scrolled out of view is no longer drawn
  (`[data-sidebar-row] > [data-sidebar-bot-row]` in `src/styles.css`). At
  456e978, where the table was measured, the whole row was skipped
  (`[data-sidebar-row]`); the row itself is laid out again now so a screen
  reader can find it. Photographs of the sidebar at 80 dogs are taken by
  `--sidebar-shots DIR`.

`--profile-typing` prints the rendering stages for typing. At 80 dogs, before
these two changes, 99 keys cost 1.7 s of layer building, 0.8 s in 683 layouts
and 0.5 s of painting.

## Still open

- Typing still keeps the main thread busy about 85% of the time at 80 dogs
  with a 240-message chat. The message box measures itself on every key
  (about seven layouts a key).
- Load at 80 dogs: the message box is ready after about 1.1 s, against 0.6 s
  with seven dogs.
- Every event redraws every component that reads the whole store, about 100
  components per commit while other dogs work.
- None of this has been measured in the Mac app. One reading from a running
  Mac app on 2026-11-10: five processes, 447 MB resident, 388 MB of it the
  window's renderer, on a machine with 4.2 GB of swap in use.

## Review of 2026-11-10 and what was done about it

An independent read of this branch at 456e978 raised seven findings. Each is
fixed with a test; the numbers are fixture measurements on the Linux cloud
computer.

| Finding | What changed | Tests |
|---|---|---|
| R1 The "Earlier work" line flashed and changed during the fill | The line is counted against the rows of the filled window from the first frame | `src/components/ChatView.opening.test.ts` "shows the same earlier-work line at every step of the fill"; `src/hooks/use-transcript-viewport.test.ts` "names the rows of the filled window from the first frame" |
| R2 A skipped sidebar row held the wrong height | Each row is marked plain, titled or icon and holds the height that kind draws at | `src/lib/sidebar-row-kind.test.ts`, `src/components/Sidebar.rows.test.ts`, and `--sidebar-rows` below |
| R3 Rows filled in after opening slid in as if new | Rows older than the ones the chat opened on never count as arriving | `src/lib/arrivals.test.ts`, `src/components/ChatView.opening.test.ts` "slides in only rows that are newer than the ones the chat opened on" |
| R4 The "N new" pill could be dismissed by the short opening | A chat whose first unread row is older than the newest rows opens on its whole window | `src/lib/transcript-window.test.ts`, `src/hooks/use-transcript-viewport.test.ts` "opens on the whole window at once when the first unread row is older than the newest rows", `src/components/ChatView.opening.test.ts` |
| R5 A streaming reply could hold the fill back and move a reader | The fill is applied within the frame that asks for it, with the height captured in that commit | `src/hooks/use-transcript-viewport.test.ts` "fills in within the frame that asks", `src/components/ChatView.opening.test.ts` "fills in at the same pace while the newest reply keeps growing", and the "fill" rows below |
| R6 The unfilled window was a raw index with no bound | The fill counts from the id of the row it showed first; showing earlier rows or an older page finishes the fill first | `src/lib/transcript-window.test.ts`, `src/hooks/use-transcript-viewport.test.ts` "finishes the fill before showing earlier rows", "shows the same rows and then the whole tail when an older page lands during the fill", "never shows more than a window when a burst of new rows lands during the fill" |
| R7 The fake engine needed two settings to stream and blocked while it waited | The stream file alone is enough, and the wait between pieces leaves the event loop free | `server/testing/fake-claude-stream.test.ts` (3 tests) |

The reviewer's list of missing tests is covered by the tests above plus
`src/components/DogAvatar.test.ts` (a face joins and leaves the shared blink
clock) and `src/components/NativeWork.test.ts` (a work row redraws only when
its run is replaced).

### Sidebar rows, measured with `--sidebar-rows` at 80 dogs (two runs at 456e978, three now, all the same)

| | At 456e978 | Now |
|---|---|---|
| Height held while not drawn, list | 52 px until a row has been drawn once | 53.5 px plain, 69.5 px titled |
| Height when drawn, list | 53.5 px plain, 69.5 px titled | 53.5 px plain, 69.5 px titled |
| Height held and drawn, icon rail | 52 px until drawn once, and 56 px | 56 px and 56 px |
| One click on the unread pill, 34 rows not drawn above the target, 17 of them titled | In view, 250 px below the middle | In view, 16 px above the middle, pill gone |

The landing was photographed (`--shots`); that photograph was not looked at.

### Sidebar photographs at 80 dogs (`--sidebar-shots`, one run each of this branch and main)

Taken on the Linux cloud computer from the build of 438977a (no file under
`src` changed after it) and, for comparison, the build of main 4b377d9. Eight
photographs of this branch: the whole sidebar and a close-up of the focused
row, in the list and in the icon rail, light and dark. The helper that
finished this branch opened each of the eight and looked at it; Jacob has not.

What was seen:

- Icon rail, light and dark. The unread dot sits at the lower right corner of
  the dog's face on three of the rows in view, the focused row among them.
  Each dot is a whole circle; none is cut at an edge. The focus ring is a
  whole rounded rectangle around the focused row, all four sides and all four
  corners, a thin inner line and a thicker outer one. Not clipped.
- List, light and dark. A list row has no badge at the face's corner: its
  unread dot sits at the end of the preview line, and is whole on each of the
  four rows in view that have one. The focus ring is whole on all four sides
  and corners, with the row's "more" button inside it. Not clipped.
- The icon rail and the focused row of main look the same as this branch's in
  the three photographs of main that were opened (icon rail, its focused row,
  and the list's focused row, all light).
- In the icon rail the "12 unread" and "11 unread" pills are as wide as the
  rail, so their right end meets the rail's edge. Main draws them the same
  way; this branch does not touch them.

Recorded by the same run, in all four photographs of this branch: Tab landed
on the intended row and `:focus-visible` matched; 4 badges in the rows in view
in the list and 5 in the icon rail (three in clear view, one under the header
and one behind the lower pill), none reaching past its row's box (0 px; a
row's contents may be drawn up to 6 px past it).

Not photographed: the live-call badge at the upper right corner of a face in
the icon rail (it needs a live call), the "waiting on you" dot (it is drawn
in the same place and size as the unread dot), and anything in the Mac app.

### What `--kept` found, at 80 dogs (one run each)

| Check | main c96ea63 | 456e978 and 8924500 | Now |
|---|---|---|---|
| Draft kept per chat after switching, and after a reload | yes, yes | yes, yes | yes, yes |
| Reload opens the chat that was open | yes | yes | yes |
| Dog rows with a named button in the accessibility tree | 81 of 81 | 40 of 81: the 41 rows not drawn were left out as "not rendered" | 81 of 81, 41 of them not drawn |
| Rows Tab reaches, in view, with a focus ring | 81, 81, 81 | 81, 81, 81 | 81, 81, 81 |
| Enter opens the focused row | yes | yes | yes |

Skipping a whole off-screen row took it out of the accessibility tree, so a
screen reader could not find a dog that was scrolled out of view. The row
itself is now always drawn and only what is inside it is skipped
(`[data-sidebar-row] > [data-sidebar-bot-row]` in `src/styles.css`), and a
row in the list carries the same spoken name the icon rail already used: the
dog's name and its state ("Helper 39 · Unread"). Before this branch a list
row's spoken name was all of its text, preview line included; the preview is
no longer part of the name. `src/components/SidebarBotListItem.test.ts`
"names a row in the list for a screen reader the way the icon rail does".

## Second review of 2026-11-11 and what was done about it

A second independent read, at 024af20, found no blocker and raised two things
to fix and six notes.

| Finding | What changed | Tests |
|---|---|---|
| S1 The tables were measured before the first review's fixes and did not say so | Both tables say they were measured at 456e978, before the review fixes, and name the two later commits that change what they time | none; no code |
| S2 "Show earlier messages" was counted against the rows shown so far, so a 100-message chat showed it with 70, 40, then 10 more and then lost it, and a longer chat showed a changing number | While a chat fills in, the rows above it are counted from where the window will settle | `src/components/ChatView.opening.test.ts` "shows the same earlier-work line at every step of the fill" (the button reads "30 more" at all four steps of a 150-message chat) and "never offers earlier messages while a chat that fits one window fills in"; `src/hooks/use-transcript-viewport.test.ts` "counts the rows above the filled window at every step" |
| N1 A group chat opened on its newest 30 rows even when unread rows started above them, so its New line moved | The group chat reads its unread boundary once and hands it to the same opening rule a one-dog chat uses | `src/components/GroupView.opening.test.ts` (3 tests; the first fails without the change: 30 rows instead of 120) |
| N5 Nothing a person sees had been looked at since the sidebar change | Photographs taken and looked at; see "Sidebar photographs at 80 dogs" above | none |

Left as they are, for a person to decide:

- N2. A list row's spoken name is the dog's name and its state. The title
  line and the last-message preview are no longer part of it. Not checked
  with a real screen reader.
- N3. A row that is off screen when the sidebar changes between list and icon
  rail, or when it gains or loses a title, holds its old height until it is
  drawn again. A few pixels a row, and it corrects itself. Not measured: the
  harness reloads before measuring the icon rail.
- N4. `src/lib/sidebar-row-kind.test.ts` pins six lines of the row's class
  names as text, so a restyle of the row fails it.
- N6. A chat with more than 30 rows of new work since the last visit opens
  on its whole window, the slower way, so its New line and "N new" pill are
  right. The fixture's long chat is always read when it is opened, so the
  opening times in the tables describe read chats.

## What still needs the Mac app

Everything above is a headless Chrome on Linux against a fixture. Not measured
or checked anywhere yet:

- Cold launch of the packaged app, from click to a usable chat.
- Memory of the app's whole process tree (main, renderer, GPU, helpers) at
  idle and under load.
- Dictation and push-to-talk while a long chat is open.
- Permission prompts (microphone, screen, accessibility, files).
- Signing, notarization and the update path.
- A real screen reader on the Mac reading the sidebar, and the sidebar's
  badges and focus ring seen in the Mac app (they were photographed in
  headless Chrome on Linux only).

## Where this lane stands, 2026-11-11

Run on the Linux cloud computer at c688af6, in a copy whose git tree hash
matched the commit (the commits after it change only this note):

- `pnpm typecheck` (`tsc -b && tsc -p tsconfig.server.json`): no errors.
- `pnpm lint` (`oxlint --deny-warnings .`): 0 warnings, 0 errors, 3,059 files.
- `pnpm vitest run src scripts/no-comments.test.ts scripts/brand-links.test.ts
  server/testing`: 418 files, 3,627 tests, all passed.
- The harness ran end to end in its `--sidebar-shots` mode against the builds
  of main 4b377d9 and this branch (438977a), once each.

Run earlier, at fa3141c: the harness's `--sidebar-rows` and `--kept` modes
against the builds of main, 456e978 and this branch. Not rerun since.

Also run at c1c6997: `pnpm lint` again (0 warnings, 0 errors), the
two rules tests again (17 tests passed), and
`scripts/testing/verification-docs.test.ts`, which is not part of the command
above: 4 of its 6 tests passed. The 2 that failed are both about
`docs/verification/decision-eval.md`, a note that came in from main and that
this branch does not touch: it is not linked from the index, and it cites four
test files by name without their folder. Main's index does not link it either
(read in main's files; the test was not run on main).

Not run: the whole suite (`pnpm vitest run`, with every server test). On this
cloud computer two server tests fail on main itself, in files this branch
does not touch: `server/config.test.ts` "uses the list again once a file the
server could not read is readable" and `server/drivers/agents-proxy.test.ts`
"answers the MCP handshake and lists the agents tools".

Left: the timed runs of main against this branch at 7 and 80 dogs. They were
queued on 2026-11-11 with the builds of main 4b377d9 and this branch at
438977a (no file under `src` changed after it), and had not once got the
cloud computer to themselves when this was written: other lanes' test suites
held it throughout. Until they run, the two tables above describe 456e978. One round
(each build at 7 and at 80 dogs, once) is still waiting on the cloud computer;
if it runs, its results are `~/perf/r158f/{main,head}-{7,80}-1.json` there and
`python3 ~/perf/r158f/table.py` prints them side by side.

## The store branch (`atelier/desktop-store`), 2026-11-11

Stacked on the branch above. What it changes:

- The shell, the sidebar, the chat view, the message box and about sixty
  smaller parts read only the part of the store they draw
  (`src/state/store-selectors.ts`, `src/state/store-channel.ts`), instead of
  redrawing on every store change.
- The message box measures its height only when its height can change
  (`src/lib/textarea-height.ts`).
- A shown status dot is no longer kept on a layer of its own after its
  entrance (`src/chat-calm.css`).
- The unread count on the app icon is its own small part
  (`src/components/UnreadCountBadge.tsx`), so the shell does not redraw when a
  dog turns unread.

### Where this branch stands

Review fixes, after the review of 90f68ac:

- Language change. The sidebar's dog rows and room rows are memoized, and a
  language change is not a store change, so they kept the old language. The
  sidebar now hands both rows the active language
  (`src/components/Sidebar.tsx`), so the shell's redraw after a language change
  reaches them. `src/components/Sidebar.language.dom.test.ts` draws the real
  sidebar under a parent, changes the language and redraws the parent, with no
  store change. Against the sidebar as it was at 90f68ac it fails twice: the
  dog row stayed "Scout · Working" where "Scout · Trabajando" was expected,
  and the room row stayed "The dogs are working…" where "Los perros están
  trabajando…" was expected. With the fix, 4 of 4 pass.
- Needs-you row. A click on a needs-you row reads the other dog's open task
  from the whole store at the click (`src/components/ChatView.tsx`), not from
  the list of drawn dogs, which is not refreshed when only a dog's open task
  changes. Before, the click reopened a task the dog already had open.
- Model line in the work detail. The "Running on … Selected: …" line takes the
  selected model from the chat's own dog, and from the open task when the task
  has a model of its own, not from the list of drawn dogs. Before, it showed
  the previous model after a change.
- Both chat fixes have a test in `src/components/ChatView.rows.test.ts`; each
  failed against the chat view as it was at 90f68ac (an extra `openTask` in the
  dispatched actions; "same" where "next-message" was expected) and passes now.
- Main f7cae29 is merged in. It touched no file under `src`.

Done, on the Linux cloud computer against fixtures, with this note in place on
top of 13f5cd4, one run each:

- `pnpm vitest run src scripts/no-comments.test.ts scripts/brand-links.test.ts
  scripts/import-cycles.test.ts`: 420 files, 3,639 tests, all passed. The
  server tests are not in this command.
- `pnpm typecheck`: no errors. `pnpm lint`: 0 warnings, 0 errors.

Earlier on this branch, not repeated after the review fixes: `--kept` at 10
dogs, one run: drafts kept after switching and after a reload, the same chat
open after the reload, and the dog that was not open showed working, then
unread, then read once opened.

Left:

- No timed table for this branch. The timed runs at 80 dogs were not finished
  here; they are to be measured on main after this merges.
- Not run for the review fixes: the server tests, the packaged app, any
  browser run. The three fixes are covered by component tests only.
- On the Mac: typing and streaming in the packaged app with real dogs, memory
  of the app's whole process tree, the status dot's entrance on a real screen,
  and a language change in Settings with the sidebar in view.
