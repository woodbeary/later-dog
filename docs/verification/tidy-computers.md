# A tidy cloud computer

What a dog's cloud computer should look like whenever the person opens it: one browser window, the page the dog
left on screen, and nothing else it opened. How it works is in "A tidy computer" in
`deploy/laterdog/computers/README.md`.

## Run

Unit and behaviour tests, no browser:

```sh
bun run vitest run server/laterdog/cloud-tabs.test.ts server/laterdog/tab-keeper.test.ts server/laterdog/computer-upkeep.test.ts server/cloud-computer-tools.test.ts server/laterdog/page-tools.test.ts server/system-prompt.test.ts
```

With a real Chromium (any Chromium or Chrome binary; on a Mac, Google Chrome's):

```sh
LATERDOG_BROWSER_STEPS_CHROMIUM=/path/to/chromium LATERDOG_TIDY_TABS_RECEIPT=/tmp/tidy-receipt.json \
  bun run vitest run scripts/browser-steps/page-tabs.test.ts server/laterdog/tidy-tabs.e2e.test.ts
```

Both are skipped when no Chromium is found. On a Mac, point `LATERDOG_BROWSER_STEPS_CHROMIUM` at a two-line wrapper
that runs Google Chrome with `--use-mock-keychain`: the tests point `HOME` at a temporary folder, and Chrome then
waits on the keychain and pages never load (this is also why `scripts/browser-steps` time out there without it).

- `scripts/browser-steps/page-tabs.test.ts` drives `open_url`, `page_open` and `page_read` against a headless Chromium
  through the same commands a computer runs, with a real `TabKeeper`: page after page in one tab, a second tab only
  with `new_tab`, never more than four tabs, and a kept page surviving the turn end.
- `server/laterdog/tidy-tabs.e2e.test.ts` starts an isolated later.dog server (temporary home, the fake engine holding
  each turn open until the test lets it finish), a Boat stand-in that runs the server's tab commands on this machine
  against a headless Chromium on its own profile and port, and a local page site. It runs three turns of one dog:
  five pages one after another, two pages side by side, and eight new tabs with one kept open. It counts the tabs
  during and after each turn and adds up the browser's memory (every process under the browser). The stand-in runs
  only DevTools listings and closes and the page agent; any other command (the server's screen checks) gets a canned
  answer and is never run. An `xdg-open` stand-in opens a
  new tab through DevTools, as `xdg-open` does on a computer, so the same test also runs against code from before the
  change. `LATERDOG_TIDY_TABS_RECEIPT` writes the counts as JSON.

## Results

The fixture, on 2026-11-20 at this branch's head (macOS, headless Google Chrome, three turns of one dog). Browser
memory is the resident memory of every process under the browser, which counts shared pages more than once:

| Turn                          | Code        | Tabs at the start | Most tabs during the turn | Tabs after the turn | Browser memory, most during | Browser memory, after |
| ----------------------------- | ----------- | ----------------: | ------------------------: | ------------------: | --------------------------: | --------------------: |
| five pages, one after another | `main`      |                 1 |                         6 |                   6 |                    1,275 MB |              1,053 MB |
| five pages, one after another | this change |                 1 |                         1 |                   1 |                      880 MB |                884 MB |
| two pages side by side        | this change |                 1 |                         2 |                   1 |                    1,179 MB |              1,067 MB |
| eight new tabs, one kept      | this change |                 1 |                         4 |                   2 |                    1,429 MB |              1,194 MB |

`main` is 2a70df9ff, where the second and third turns cannot run: its `open_url` has no `new_tab` or `keep_open`.

Live, on 2026-11-19, test home `test-desk3`, its dog's new cloud computer `cmp_lyed3y6pp7fp` (standard-2: 1 vCPU,
6.4 GB; production image `b388a2d6…`, Chromium 156 on Debian trixie). The pages were Wikipedia articles. Commands went
through the owner route `POST /api/bots/:id/computer/exec`, so this server's code was not running on that home: the
"old" rows run `open_url`'s command from `main` (`nohup xdg-open …`), the "new" rows run the commands this change sends
(the page agent's `go`, `closeTabsScript`, `computerUpkeepScript()`). "Memory used" is `free -m`; "Chromium" is the
proportional memory (`Pss`) of all its processes.

| Step                                         | Tabs | Chromium processes | Chromium memory | Memory used | Browser cache |
| -------------------------------------------- | ---: | -----------------: | --------------: | ----------: | ------------: |
| As found (new computer, browser not started) |    0 |                  0 |               0 |      383 MB |             0 |
| Old: a turn with 5 × `open_url`              |    5 |                 14 |    not measured |      951 MB |        4.1 MB |
| Old: a second turn, 5 more                   |   10 |                 19 |          929 MB |    1,070 MB |        7.0 MB |
| Old: after sleep and wake, one `open_url`    |   11 |                 12 |          562 MB |      709 MB |        7.3 MB |
| New: the turn-end tidy on those 11           |    1 |                 10 |          507 MB |      672 MB |        7.4 MB |
| New: a turn with 5 × `open_url`              |    1 |                 10 |          701 MB |      860 MB |        7.4 MB |
| New: after that turn ended                   |    1 |                 10 |          698 MB |      860 MB |        7.4 MB |

The restored tabs after the wake were not loaded yet, which is why 11 tabs used less memory than 10. One tab after
five pages still holds some of the earlier pages in the browser's back-forward cache.

The end-of-turn upkeep, live on the same computer with seeded files:

- `~/Downloads`: a 2-day-old file, a 3-hour-old partial download and an empty 2-day-old folder were removed; a file
  and a partial download from today stayed (8.8 MB → 1.1 MB).
- `/tmp`: the dog's 2-day-old file was removed, today's stayed (2.0 MB → 0.1 MB).
- The browser cache, with a 1 MB cap to force it: 7.4 MB → 0 through DevTools while Chromium ran, its tab still open.
- With a 20% and 3-second bar to force it: a spinning `sh` loop was stopped; a loop at the same CPU with
  `LATERDOG_RUN_ID` set, a quiet process, Chromium, `xfwm4`, the panel and `Xvfb` were left alone.
- The default upkeep (256 MB cache, a day, half a CPU for 30 minutes) ran in 0.8 s and changed nothing on a clean
  computer.

The image change, checked on the same Chromium by putting the same policy in its managed policy folder and restarting
it: `chrome://policy` showed `DiskCacheSize 104857600`, Machine, Mandatory, Status OK (without it: Not set). The
check's policy file was removed afterwards.

## Not proven

- A real dog's turn on a live home running this code. The live check ran this change's commands through the owner
  route; the turn-end trigger, the cap after each call and the reuse choice ran only in the fixture.
- That `DiskCacheSize` keeps a busy browser's cache near 100 MB over hours; only that Chromium accepts the policy.
- The fixture's browser is headless Chrome on macOS, so its memory numbers are not a computer's.
- A person's tabs opened outside later.dog's take-over (straight through a desktop link) are treated as the dog's.
