# Item 33, stage one: how a dog drives a browser and its computer, measured

15 November 2026, on `main` `0651657`. Nothing in later.dog's behaviour changes on this branch: it adds a fixture site, a scripted caller, two stand-in tool servers and the maintainer's real-engine runner, all under `scripts/browser-steps/`.

## 1. What a dog has today

**Screen tools** (`server/cloud-computer-tools.ts`, served by the computers service, `deploy/laterdog/computers/src/mcp-screen.ts` and `computer.ts`): `screenshot`, `get_screen_size`, `click`, `move`, `drag`, `type_text`, `key_press`, `scroll`, `open_url`, plus `exec`. Their definitions are 6,852 bytes (about 1,700 tokens) on every request.

- One `screenshot` is the whole 1280x800 desktop (`start-desktop.sh`, `DESKTOP_GEOMETRY`), taken by `scrot --quality 75` and sent to the engine unchanged as a base64 JPEG. On the fixture pages that was 78 to 143 KB of base64, about 1,366 image tokens each, estimated as width x height / 750.
- The screen frame gate (`server/screen-frame-gate.ts`) does not shrink or drop anything the model gets. It only decides whether a settled frame is new enough to show the person (a hash of the frame against the last one shown).
- Every other screen call returns a short text result (`{"ok":true,"exitCode":0,...}`, about 87 bytes).
- `open_url` starts the browser and says the page load is not confirmed, so a dog has to take a screenshot to see anything.

**Structured page tools** (`server/browser-engine.ts`, `browser-runtime.ts`, `browser-tool-shape.ts`): the pinned browser engine, version 0.37.0, through `BrowserRuntime`. It offers 30 `agent_browser_*` tools whose definitions are 12,766 bytes (about 3,200 tokens). One `open` returned 900 to 1,900 bytes, a `read` 300 to 1,700, a `click` or `fill` about 510.

- **These tools are switched off for every dog.** `builtInBrowserEnabled` in `server/config.ts` returns `false` unconditionally. Even when it is on, `server/index.ts` mounts the browser only when no computer is mounted for the turn (`!(plan.computer === undefined && mountedComputer)`).

**What the instructions steer toward:**
- A cloud-home dog is told: "You control the assigned cloud computer. Inspect it with screenshots" (`computerPrompt("box")`). It is also told its cloud computer is "a desktop in the cloud with its own browser" (`cloudHomePrompt`).
- `BROWSER_PAGE_PROMPT`, which steers toward snapshots and `agent_browser_get_text`, is only sent when the browser tools are mounted, which today is never.

## 2. Three web tasks on a fixture site, structured tools against screenshots

Measured on my cloud computer, a Linux machine with 4 cores. The fixture site is `scripts/browser-steps/fixture-site.ts`, a 14-link shop with a 30-item list, so the pages are not toy-sized. The structured path used the real engine through later.dog's `BrowserRuntime`. The screen path used Chromium on an X display, driven by the same `xdotool` and `scrot` commands the computers service runs. The caller is a script: it knows where to click and takes the fewest screenshots a careful model could. A real model takes more (section 3).

| Task | Path | Tool calls | Model turns (min) | Tokens added by tool results | Image share | Tokens re-read over the task | Tool seconds (sum) | Done right |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| find a fact, follow one link | structured | 4 | 5 | 1,167 | 0% | 3,648 | 0.86 | yes |
| find a fact, follow one link | screen | 6 | 7 | 4,201 | 98% | 12,731 | 1.02 | yes |
| fill and send a five-field form | structured | 8 | 5 | 1,252 | 0% | 3,813 | 0.94 | yes |
| fill and send a five-field form | screen | 15 | 16 | 3,094 | 88% | 23,509 | 0.87 | yes |
| sign in, then read a table | structured | 5 | 5 | 840 | 0% | 2,235 | 0.87 | yes |
| sign in, then read a table | screen | 8 | 9 | 2,907 | 94% | 11,786 | 15.63 | yes |

- **Re-read:** each tool result stays in the chat and is sent again with every later request. "Tokens re-read" sums that over the task's turns. Text tokens are bytes / 4.
- **Tool definitions:** adding the definitions each request carries (about 3,200 tokens structured, 1,700 screen) gives:
  - find: 19,600 structured against 24,700 screen
  - form: 19,800 against 50,900
  - table: 18,200 against 27,200

  Most of those definitions are cached reads.
- **Seconds per step:**
  - A structured `open` took about 0.7 s and every other structured call under 0.08 s.
  - A screenshot took 0.03 s; a click about 0.11 s; typing about 0.14 s.
  - One click took 15.2 s (first click on the sign-in page). I checked whether repeating `mousemove --sync` to the same spot stalls: it took 0.02 s, so the cause is not found.
- **Model turns** are the minimum: the structured form fills all five fields in one turn, because the model can send several calls in one request. The screen form needs a click, then typing, then a key, each waiting on the last.

**Smaller screenshots of the same screen:**

| Variant | JPEG bytes | Base64 in the result | Image tokens | Seconds |
| --- | ---: | ---: | ---: | ---: |
| today: 1280x800, quality 75 | 45,572 | 60,764 | 1,366 | 0.028 |
| 1024x640, quality 60 | 21,012 | 28,016 | 874 | 0.041 |
| 800x500, quality 50 | 13,887 | 18,516 | 525 | 0.036 |

**What these numbers do not contradict:** on every task the structured path needs fewer turns and 3 to 6 times fewer re-read tokens, and no image. Even counting its larger tool list, it costs 1.3 to 2.6 times less. Structured snapshots never cost more than a capped screenshot here: the biggest structured result (1,932 bytes, about 490 tokens) is smaller than an 800x500 screenshot.

Per-step tables: `docs/browser-steps/fixture-run-2026-11-15.md`.

## 3. What dogs really reached for, from the last week of chats

**How I counted:** `session_search` with bot "all", since 7 days, for "mcp__computer__screenshot" and for "screenshot click", 25 hits each. Each hit that is a turn digest lists that turn's tool calls with counts. I read 22 distinct turn digests from 7 dogs, 9 to 14 November. I also searched "agent_browser" (7 days) and "mcp__browser" (14 days).

| | Count |
| --- | ---: |
| Turns read | 22 |
| `mcp__computer__screenshot` calls | 392 |
| `mcp__computer__click` calls | 354 |
| `agent_browser_*` or `mcp__browser__*` calls | 0 |
| Screenshots per turn, median | 11.5 |
| Screenshots per turn, short steps (a sign-in, a check) | 1 to 4 |
| Screenshots per turn, a whole web task (the testers' rounds) | 45, 50, 54, 57, 80 |

- At about 1,366 tokens each, a turn with 80 screenshots carried about 109,000 image tokens. Each later request in that turn re-read the ones before.
- The same turns also called `mcp__computer__exec` hundreds of times. What those commands did I did not read.
- **How sure:** the search returns at most 25 hits, so this is a sample, not every turn. It leans toward the testing dogs that ran long web tasks on 9 November. The zero for the structured tools is certain for what was searched, and it matches the code: those tools are off.

## 4. The real-engine check, for the maintainer

Isolated machine, a signed-in Claude Code on a test account, this repository with its packages installed, Chromium, the pinned browser engine 0.37.0, and an X server through `xvfb-run`. No real site, no person's account. The fixture site runs on 127.0.0.1 and the sign-in is a fixture account.

```sh
xvfb-run -a -s "-screen 0 1280x800x24" node --experimental-strip-types scripts/browser-steps/real-engine.ts \
  --engine "$(command -v agent-browser)" \
  --models claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5 \
  --out "$HOME/browser-steps-real-$(date +%Y%m%d-%H%M%S)"
```

`--engine` takes the pinned browser engine binary; the home image has it on its PATH. `--chromium` defaults to `/usr/bin/chromium`; `--cli` defaults to `claude`.

For each model it runs the three tasks once through the structured tools and once through the screen tools. Each run:
- has only one tool server mounted: `structured-server.ts` (the real engine through `BrowserRuntime`) or `screen-server.ts` (the screen tools with the same commands);
- gets the dog's standing instructions plus `BROWSER_PAGE_PROMPT` or the cloud-computer paragraph;
- runs in a fresh empty folder with `--strict-mcp-config` and `--setting-sources project`.

It prints one row per run:
- model turns (requests), tool calls;
- input tokens over all requests and in the last request;
- image tokens, and their share of the last request;
- tool seconds, wall seconds;
- whether the reply held the right answer, and the exit code.

It also writes `summary.md`, `results.json` and each raw turn to `--out`.

## 5. What to build, in what order

1. **Step 4 first: smaller screenshots, and old ones dropped from the chat.** It is the only change that saves tokens for dogs as they work today, since every web task now goes through screenshots.
   - 1024x640 at quality 60 saves 36% per screenshot (874 tokens against 1,366); 800x500 at quality 50 saves 62% (525). On the long tester turns that is 39,000 to 68,000 tokens per turn before any dropping.
   - Dropping screenshots already acted on saves most of the re-reading on top of that.
   - It changes `computer.ts` in the computers service, so it needs a full deploy by the maintainer.
   - A zoom tool covers detail the smaller size loses. Whether a model still clicks accurately on a smaller image is for the real-engine run to show.
2. **Step 2 next: page structure as the default inside a browser.** The numbers support it strongly: 3 to 6 times fewer re-read tokens, 5 turns where the screen path takes 7 to 16, and no images, so a model without vision can finish.
   - It cannot start as a prompt change. The tools are switched off in code, and are not mounted at all on a turn with a computer.
   - First decide where the engine runs for a cloud-home dog: on the home (its image already has the engine), or on the dog's cloud computer. The home has little memory and disk to spare, so the computer is the likely place.
3. **Step 3: one call for a run of actions.** It matters mostly on the screen path: the form took 16 turns there and 5 structured.
   - A batched click, type and key call with one reading at the end would bring the screen form to about 4 turns, and its re-read from 23,500 tokens to about 5,000 (estimated, not measured).
   - On the structured path the model already sends the five fills in one request, so the saving there is small.
4. **Step 5 last: a managed browser session for page-only work.** These numbers say nothing about it, because it changes where the browser runs, not what a step costs. Its case is start time:
   - item 36's notes record snapshot boots of about 4 minutes against a 5-minute limit;
   - a computer that will not start blocks every web task today.

   Measure a managed session's start time before building it.

## 6. A cloud computer that does not start (item 36, read only)

1. Proven: the interrupts on 11 and 14 November were the home's own start limit, 330 seconds from the first screen call.
2. Not proven: the cause. The leading guess is that an old dog's computer boots from a snapshot that has grown, holding every folder ever sent to it (Atelier's `w3` was 1.7 GB), and no longer restores within the service's 5-minute limit. New dogs boot from the image and start.
3. Until `fable/fix-computer` lands and the service is deployed, the service's own reason never reaches the dog, and its logs kept only 1 call in 10.
4. On that branch, a failed start gives the dog one plain sentence and is held for 10 minutes before trying again; it is not merged or deployed.
5. **What can be done today:**
   - Jacob can reset the stuck dog's computer in Settings → Computer → Cloud computers. A reset boots from the image, which starts.
   - A dog can carry on with its work in its own folder on the home, and send less to its computer with `run_on_computer`, so the snapshot stays small.

## What only a real engine or real sites can prove

- How many turns and screenshots each model really takes, and whether it finds the right element.
- Whether a smaller screenshot costs click accuracy.
- Every token count per model; the fixture numbers are estimates from bytes and pixels.
- How the pages of real sites compare in size to the fixture.
- The managed browser's start time and its live view for a sign-in.
- The cause of the 15-second click.
