# Desktop performance, measured against a fixture

Every number in this note comes from headless Chromium on Linux against
fixture data. None of it was measured in the Mac app.

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
- `--profile-switch` prints where the time goes while switching chats, and
  `--probe-remove` prints any single DOM removal that took over 1.5 ms.

## What it records

| Step | How |
|---|---|
| Load | First paint and the moment the message box exists, each in a fresh browser profile |
| Chat switching | Click a sidebar row; stop when the chat's message box and a row of its transcript are on screen for two frames |
| Typing | 119 keys at 35 ms; key press to the second frame after it |
| Scrolling | 90 wheel steps through the long chat |
| A streamed reply | Enter to the person's own bubble, and to the first words of the reply; frames and long tasks until the dog settles |
| Other dogs working | Four other dogs take a streamed turn while an idle chat is open |
| Redraws | A second pass counts React commits and components that redrew, through the commit hook |
| Memory | JS heap after a collection at idle and after the run, DOM nodes, and resident memory of the server tree and the browser tree at idle, at its highest during the timed pass (sampled every second) and at the end |

The fake engine streams a reply in pieces when `FAKE_CLAUDE_STREAM_FILE` names
a JSON file `{ "everyMs": 30, "chars": 10 }`, and reads scripted replies from
`FAKE_CLAUDE_REPLIES_FILE` when the list is too long for the environment.

## Results, 2026-11-11: base 651cf65 against main 89b1439

In progress: the runs are still going and the tables below fill in as each
round finishes. The run count is in each table's heading. Until every table
has its five runs, read the verdicts as provisional.

"base" is the renderer built at 651cf65, main on 2026-11-10 before the
desktop work. "main" is the renderer built at 89b1439, with #158, #164, #171
and #169 in it. Both are measured by main's `scripts/desktop-perf.ts` on the
Linux cloud computer (4 cores, 12 GB, Chromium 156 through Playwright 1.56.1,
Node 24.22.2) against fixture data. Nothing here was measured in the Mac app.

How to read the tables: each cell is the median of the runs, with the lowest
and highest run in brackets. "Difference of medians" is main minus base. The
verdict is "lower in every run" or "higher in every run" only when the two
ranges do not touch; when they overlap it is "no measurable change", whatever
the medians say.

### Timed run at 7 dogs

The default timed run: base 1 run, main 1 run.

| Measure | base 651cf65, median (range), 1 run | main 89b1439, median (range), 1 run | Difference of medians | Verdict |
|---|---|---|---|---|
| Open the long chat, median of 8 (ms) | 301.9 (301.9 to 301.9) | 266.9 (266.9 to 266.9) | -35 (-12%) | lower in every run |
| Open the long chat, slowest of 8 (ms) | 339.8 (339.8 to 339.8) | 280 (280 to 280) | -59.8 (-18%) | lower in every run |
| Long chat: rows drawn when it is first shown | 120 (120 to 120) | 30 (30 to 30) | -90 (-75%) | changed |
| Long chat: all 120 rows in place, median of 8 (ms) | 292 (292 to 292) | 375 (375 to 375) | +83 (+28%) | higher in every run |
| Long chat: openings of 8 that never reached 120 rows | 0 (0 to 0) | 0 (0 to 0) | 0 | same |
| Open a short chat, median of 8 (ms) | 63.6 (63.6 to 63.6) | 69.2 (69.2 to 69.2) | +5.6 (+9%) | higher in every run |
| Long tasks across 16 switches (ms) | 2,261 (2,261 to 2,261) | 2,792 (2,792 to 2,792) | +531 (+23%) | higher in every run |
| Key press to frame, median of 119 keys (ms) | 23.6 (23.6 to 23.6) | 23.6 (23.6 to 23.6) | 0 | same |
| Key press to frame, 95th of 119 keys (ms) | 32.2 (32.2 to 32.2) | 31.9 (31.9 to 31.9) | -0.3 (-1%) | lower in every run |
| Key press to frame, slowest of 119 keys (ms) | 32.9 (32.9 to 32.9) | 32.9 (32.9 to 32.9) | 0 | same |
| Typing: frames slower than 25 ms | 0 (0 to 0) | 0 (0 to 0) | 0 | same |
| Typing: main thread busy over 5.5 s (ms) | 2,257 (2,257 to 2,257) | 2,000 (2,000 to 2,000) | -257 (-11%) | lower in every run |
| Typing: layouts for 119 keys | 768 (768 to 768) | 569 (569 to 569) | -199 (-26%) | lower in every run |
| Typing: components redrawn for 119 keys | 3,221 (3,221 to 3,221) | 3,223 (3,223 to 3,223) | +2 (+0%) | higher in every run |
| Cold load: first paint, median of 5 (ms) | 372 (372 to 372) | 452 (452 to 452) | +80 (+22%) | higher in every run |
| Cold load: message box ready, median of 5 (ms) | 547.2 (547.2 to 547.2) | 649.8 (649.8 to 649.8) | +102.6 (+19%) | higher in every run |
| Cold load: message box ready, slowest of 5 (ms) | 593.1 (593.1 to 593.1) | 668.2 (668.2 to 668.2) | +75.1 (+13%) | higher in every run |
| Idle: main thread busy per 3 s (ms) | 130 (130 to 130) | 77 (77 to 77) | -53 (-41%) | lower in every run |
| Idle: style passes per 3 s | 181 (181 to 181) | 0 (0 to 0) | -181 (-100%) | lower in every run |
| A streamed reply: frames slower than 25 ms | 5 (5 to 5) | 2 (2 to 2) | -3 (-60%) | lower in every run |
| A streamed reply: components redrawn | 8,628 (8,628 to 8,628) | 5,487 (5,487 to 5,487) | -3,141 (-36%) | lower in every run |
| Own bubble after Enter (ms) | 36.9 (36.9 to 36.9) | 28.1 (28.1 to 28.1) | -8.8 (-24%) | lower in every run |
| Four other dogs working: frames slower than 25 ms | 0 (0 to 0) | 0 (0 to 0) | 0 | same |
| Four other dogs working: main thread busy (ms) | 970 (970 to 970) | 797 (797 to 797) | -173 (-18%) | lower in every run |
| Four other dogs working: components redrawn | 1,322 (1,322 to 1,322) | 636 (636 to 636) | -686 (-52%) | lower in every run |
| Switching: components redrawn across 16 switches | 31,091 (31,091 to 31,091) | 32,933 (32,933 to 32,933) | +1,842 (+6%) | higher in every run |
| JS heap at idle, after a collection (MB) | 12.8 (12.8 to 12.8) | 12.7 (12.7 to 12.7) | -0.1 (-1%) | lower in every run |
| JS heap after the run, after a collection (MB) | 25.8 (25.8 to 25.8) | 26 (26 to 26) | +0.2 (+1%) | higher in every run |
| Page process memory at idle (MB) | 61 (61 to 61) | 59 (59 to 59) | -2 (-3%) | lower in every run |
| Page process memory, highest of 6 samples (MB) | 373 (373 to 373) | 344 (344 to 344) | -29 (-8%) | lower in every run |
| Browser process tree at idle, resident (MB) | 1,001 (1,001 to 1,001) | 1,002 (1,002 to 1,002) | +1 (+0%) | higher in every run |
| Browser process tree, highest in the run, resident (MB) | 1,337 (1,337 to 1,337) | 1,314 (1,314 to 1,314) | -23 (-2%) | lower in every run |
| DOM nodes after the run | 10,933 (10,933 to 10,933) | 10,933 (10,933 to 10,933) | 0 | same |
| Rows in the long chat 1.5 s after opening | 120 (120 to 120) | 120 (120 to 120) | 0 | same |

### Timed run at 80 dogs

The default timed run with `--other-dogs 79 --other-turns 2`: base 0 runs, main 0 runs.

### One dog streams, at 7 dogs

`--one-dog-streams`: base 0 runs, main 0 runs.

### One dog streams, at 80 dogs

`--one-dog-streams` with `--other-dogs 79 --other-turns 2`: base 0 runs, main 0 runs.

### Store changes, at 7 dogs

`--store-changes`: base 0 runs, main 0 runs.

### Store changes, at 80 dogs

`--store-changes` with `--other-dogs 79 --other-turns 2`: base 0 runs, main 0 runs.

### Layers at 80 dogs

| Build | Run | Layers | Layers that draw | Typing 48 keys in the message box as it is |
|---|---|---|---|---|
| base | base-80-layers-1 | 426 | 339 | Layerize 2938 ms x108, Paint 120 ms x312, PrePaint 52 ms x216, Layout 173 ms x300, UpdateLayoutTree 171 ms x300, EventDispatch 590 ms x387, FunctionCall 189 ms x1126 |

### How the runs were made

- `~/measure/base` is `git archive 651cf65` (tree f7700da, checked with
  `git write-tree`), `~/measure/main` is main 89b1439 (tree 415d264, checked
  the same way). Both use the same installed packages; the lockfile did not
  change between the two commits.
- Each renderer is built with `pnpm exec vite build --outDir ~/measure/dist-base`
  (or `dist-main`) from its own tree.
- The harness only exists on main, so every run is main's
  `scripts/desktop-perf.ts`, main's fixture server and main's fake engine,
  serving one of the two builds with `--dist`. Only the renderer differs
  between the columns.
- Timed runs hold `flock -x ~/heavy.lock`, so no other lane's build or test
  suite runs beside them, and go in rounds: one round is each build once at 7
  dogs and once at 80, base first in odd rounds and main first in even ones.
  Between rounds other lanes take the lock, so a round often waited for it;
  the wait and the load average when each run started are in the table below
  and in each run's `.meta.json`.
- `--kept` and `--message-box` time nothing and ran with the lock shared
  (`flock -s`), beside another lane's work.
- Every run writes one result file and one `.meta.json` (command, lock, wait
  for the lock, load average at the start and end, exit code), under
  `~/measure/results/` there and in `assets/desktop-performance/` here.
  `--store-changes` and `--layers` print their result instead of writing it to
  `--out`; for those the printed result is the `.json` file here.
  `python3 assets/desktop-performance/summarize.py --note desktop-performance.md`
  rewrites the tables in this section from those files.

### Every run, in the order it ran

| Run | Lock | Waited for the lock (s) | Ran (s) | Load at start (1, 5, 15 min) | Exit |
|---|---|---|---|---|---|
| main-80-kept-1 | s | 0 | 73 | 2.24 2.86 2.94 | 0 |
| main-80-mbox-1 | s | 0 | 66 | 3.17 3.12 3.03 | 0 |
| base-7-default-1 | x | 169 | 88 | 3.08 3.28 3.10 | 0 |
| base-80-mbox-1 | s | 54 | 159 | 1.53 2.77 2.94 | 0 |
| main-7-default-1 | x | 159 | 92 | 2.11 2.61 2.86 | 0 |
| base-80-kept-1 | s | 92 | 82 | 0.96 2.11 2.66 | 0 |
| base-80-layers-1 | x | 658 | 72 | 2.13 1.42 1.94 | 0 |

## History: results at 456e978, 2026-11-10

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
