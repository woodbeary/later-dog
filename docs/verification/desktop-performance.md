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
| Memory | JS heap after a collection, DOM nodes, and resident memory of the server tree and the browser tree |

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
