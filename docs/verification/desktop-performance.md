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

Still open, from the same runs: every event redraws every component that reads
the whole store (about 100 components per commit while other dogs work), and
one typed key redraws about 27 components.
