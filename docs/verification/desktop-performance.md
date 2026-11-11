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

Two modes check behaviour instead of timing it, and can be combined in one
run:

- `--sidebar-rows` (best with `--other-dogs 79 --other-turns 2`) gives every
  second dog a title, then records the height each kind of row holds while its
  contents are not drawn against its height when drawn, in the list and in the
  icon rail, and whether one click on the "more unread below" pill lands an
  unread row near the end of the list in view. `--shots DIR` photographs the
  landing.
- `--kept` writes a draft in two chats and checks each is still there after
  switching and after a reload, that the reload opens the same chat, that the
  accessibility tree has a named button for every dog's row whether or not
  its contents are drawn, and that Tab reaches every row with a focus ring and
  in view, and Enter opens it.

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

## Results, 2026-11-10

One cloud computer (Linux x64, 4 vCPU, 12 GB), headless Chrome, a 240-message
chat with code blocks and tables plus five short chats. These are fixture
numbers on Linux. They are not the Mac app: its launch, its process tree and a
sleeping Cloud home are not in them.

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
two.

| Measure | Before | After |
|---|---|---|
| Main thread busy while idle, per 3 s | 946 ms, a style pass every frame | 133 to 180 ms, no style passes |
| Typing: frames slower than 25 ms | 112 to 123 of about 330 | 16 of 383 |
| Key press to frame, median / 95th / worst | 31 / 50 / 101 ms | 22 / 37 / 63 ms |
| Other dogs working: slow frames, main thread busy | 30 to 38 of about 140, 2.2 s of 3 s | 0 of 177, 0.6 s of 3 s |
| A streamed reply: slow frames | 30 to 32 of about 110 | 7 of 148 |
| Open the long chat, median | 320 ms | 267 to 297 ms |
| Load: message box ready | 1,040 ms | 1,070 to 1,115 ms |

- Every dog's face ran its own endless blink animation, 80 of them, on screen
  or not, which cost a style pass on every frame. Faces now blink together
  from one clock, only the ones on screen, with a 180 ms one-shot animation
  (`src/lib/dog-blinks.ts`). The run sees a blink within half a second of
  looking for one.
- Sidebar rows scrolled out of view are no longer drawn
  (`[data-sidebar-row]` in `src/styles.css`). Screenshots of the sidebar
  scrolled to the middle of 80 dogs, and with a row hovered, are taken by
  `--shots DIR`.

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

The landing was photographed (`--shots`); the photograph was not looked at by
a person.

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

## What still needs the Mac app

Everything above is a headless Chrome on Linux against a fixture. Not measured
or checked anywhere yet:

- Cold launch of the packaged app, from click to a usable chat.
- Memory of the app's whole process tree (main, renderer, GPU, helpers) at
  idle and under load.
- Dictation and push-to-talk while a long chat is open.
- Permission prompts (microphone, screen, accessibility, files).
- Signing, notarization and the update path.
- A real screen reader on the Mac reading the sidebar, and a keyboard focus
  ring photographed on a sidebar row.

