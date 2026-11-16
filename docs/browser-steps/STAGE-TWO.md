# Item 33, stage two: what was built, with numbers before and after

Stage one is in `MEASURE.md`. This file covers the three changes built on it (A, B and C), measured with the same fixture site, on a Linux cloud computer with the same 1280x800 desktop, scrot, xdotool and Chromium as a dog's computer. No real engine, no real site. Raw output: `stage-two-run/`.

Token figures are estimates. Text is bytes divided by 4. Images use Claude's formula (width x height / 750, after shrinking an image past 1568 pixels on its long edge or 1.15 megapixels). Another engine may count differently and may resize the image itself. "Turns" is the fewest model turns a scripted caller needs, counting the turn that answers. "Re-read" adds up what each turn reads again from earlier tool results; the fixed instructions and tool list come on top of it every turn. Each path ran once: the token figures do not change between runs, but the seconds are from a single run.

## What a dog and the person see differently

- **A. Page tools, behind the switch (off by default).** With `features.pageTools` on, a dog on its cloud computer also gets eight page tools: `page_open`, `page_read`, `page_click`, `page_fill`, `page_select`, `page_press`, `page_back` and `page_text`. They read and act on the same Chromium the screen shows. Its standing instructions add one sentence: read the page's structure first, and take a screenshot only when the structure does not show what is needed. With the switch off, the tool list has no page tools, a page tool call is refused, and the instructions are byte for byte today's (a test pins their hash).
- **B. Smaller screenshots, a zoom tool, and no 15-second click.** These apply to every dog on a cloud computer the computers service runs. A computer from the older provider keeps today's full-size screenshot and real coordinates.
  - A screenshot is now at most 1024 pixels wide (1024x640 on today's desktop), JPEG quality 60. Before, it was 1280x800 at quality 75.
  - Clicks, moves, drags, scrolls and `fill_secure_field` are given in the screenshot's coordinates and scaled back to the real screen. The corners and the centre are tested for click and for `fill_secure_field`. No other route takes a dog's coordinates.
  - `zoom` shows one region at the real screen's detail, also capped at 1024 pixels wide.
  - A click to where the pointer already was took about 15 seconds before (`xdotool mousemove --sync` waits for a move that never comes); now the pointer is moved only when it is elsewhere.
  - The person's live view and the frame kept in the chat still come from the full-size frame.
- **C. `run_actions`.** One call for up to 25 steps (click, type, key, scroll and wait, plus page_click, page_fill, page_select and page_press when the page tools are offered).
  - Every step is checked before any runs. The run stops at the first step that fails, and says which step and what was done before it.
  - It ends with one reading: the page structure when the page tools are offered, otherwise one screenshot.
  - A secure field, a secure form, a vault item or a command cannot be part of a run.
  - Before every step and before the reading, it checks that the person has not taken control of the computer; if they have, it stops and says what ran. A wait ends at once on Stop.

## What the page tools never show

A text field, password, one-time code, card number or editable area shows only as `(filled)` or empty in `page_read`; `page_text` of a field answers `(filled; field values are not shown)` or `(empty)`; text read from a part of the page leaves editable areas out; the reading at the end of `run_actions` uses the same path. This holds for every field, not only the ones a Secure Form typed: the home cannot know for sure which fields a paste reached, or what the page did to a value (a card number grouped in fours, for instance), so masking only the exact values could miss one. A dog still knows what it typed itself with `page_fill`.

## The page tools and tabs

`page_open` opens a new tab, brings it to the front and reads it; `page_open`, `page_click`, `page_press` and `page_back` report the browser's tabs through the same tab tracking `open_url` uses. The other page tools act on the tab in front, which is the one last opened or brought forward. A known limit: if the person or another task of the same dog brings a different tab forward, the next `page_read` or `page_click` acts on that tab, and a ref from the earlier page answers "No element … on this page; read the page again."

## Where the page engine runs, and why

The page tools send a small self-contained script to the computer with each call. It runs on the computer's own Node 24 (the image is `node:24-trixie-slim`) and drives the computer's Chromium through the debugging port it already opens (`--remote-debugging-port=9339` in `deploy/laterdog/computers/container/chromium-flags`; the tab tracking already reads it). Nothing new is installed on the computer or the home, and nothing needs a deploy.

Ruled out:
- The pinned browser engine on the computer: it would mean a 14 MB binary in the image, so an image change and a deploy, and its 30 tools at 12,766 bytes.
- The home's engine attached to the computer's browser: it needs the computer's port 9339 reachable from the home, which the computers service does not offer today.

## The screenshot size chosen

1024 pixels wide, JPEG quality 60, the middle row of stage one's table:

| Size | JPEG bytes | Image tokens |
| --- | ---: | ---: |
| Today: 1280x800, quality 75 | 45,572 | 1,366 |
| Chosen: 1024x640, quality 60 | 21,012 | 874 |
| 794x496, quality 50 | 13,887 | 525 |

The smallest would save 40% more a picture. Nobody has checked whether small text is still readable at that size on real sites, so it was not chosen. `zoom` covers the detail the chosen size loses.

## Before and after

Before is today's screen path, rerun now: the same numbers as stage one.

### A. Page structure first (switch on), against today's screenshots

| Task | Turns, today → page | Tokens added | Re-read | Image share | Tool seconds | Done right |
| --- | --- | --- | --- | --- | --- | --- |
| find | 7 → 3 | 4,201 → 848 | 12,731 → 1,494 | 98% → 0% | 1.01 → 1.06 | yes, yes |
| form | 16 → 4 | 3,094 → 502 | 23,509 → 1,064 | 88% → 0% | 0.88 → 3.59 | yes, yes |
| table | 9 → 4 | 2,907 → 554 | 11,786 → 954 | 94% → 0% | 15.64 → 2.06 | yes, yes |

- A page tool call takes about half a second, because it starts Node on the computer each time. A screen action takes 0.02 to 0.14 seconds.
- On a dog's real computer, every call also crosses the network to the computers service, which these numbers do not include.
- A scripted caller that is shown no image at all (each image is replaced by a refusal) finishes all three tasks with the right answers: `scripts/browser-steps/no-vision.test.ts`.

### B. Capped screenshots, the same steps as today

| Task | Turns | Tokens added | Re-read | Image share | Tool seconds |
| --- | --- | --- | --- | --- | --- |
| find | 7 → 7 | 4,201 → 2,725 | 12,731 → 8,303 | 98% → 96% | 1.01 → 1.08 |
| form | 16 → 16 | 3,094 → 2,110 | 23,509 → 16,129 | 88% → 83% | 0.88 → 0.91 |
| table | 9 → 9 | 2,907 → 1,923 | 11,786 → 7,850 | 94% → 91% | 15.64 → 0.54 |

- The table task's 15 seconds was one click on the spot where the previous task's click had left the pointer.
- On the cloud desktop itself, a move to the pointer's own spot took 15,382, 15,155 and 15,151 ms before the fix, and 218, 14 and 14 ms after it.

### C. One call for a run of actions

| Task | Path | Turns | Tokens added | Re-read | Tool seconds |
| --- | --- | --- | --- | --- | --- |
| find | capped screenshots → with run_actions | 7 → 5 | 2,725 → 2,733 | 8,303 → 5,511 | 1.08 → 1.89 |
| form | capped screenshots → with run_actions | 16 → 4 | 2,110 → 1,957 | 16,129 → 2,914 | 0.91 → 1.71 |
| table | capped screenshots → with run_actions | 9 → 4 | 1,923 → 1,876 | 7,850 → 2,831 | 0.54 → 1.34 |
| find | page → with run_actions | 3 → 3 | 848 → 848 | 1,494 → 1,494 | 1.06 → 1.05 |
| form | page → with run_actions | 4 → 3 | 502 → 521 | 1,064 → 752 | 3.59 → 3.65 |
| table | page → with run_actions | 4 → 3 | 554 → 572 | 954 → 753 | 2.06 → 2.14 |

- Stage one estimated the screen form at about 4 turns. Measured, it is 4.
- The run's seconds include an 800 ms wait the caller adds after a submit.
- All three changes together, for the form: 16 turns and 23,509 tokens re-read today, against 3 turns and 752 tokens re-read with the page tools and run_actions.

### What the tool list costs

The computer tools' definitions take 6,852 bytes on main. With the switch off they take 9,180 bytes, about 580 more tokens on every request of every dog with a cloud computer: zoom, run_actions (1,560 bytes) and longer screenshot wording. With the switch on they take 11,294 bytes; the eight page tools are 2,114 bytes. (The measured runs were made at the stage-two head, when the switch-off list was 9,145 bytes.)

## Old screenshots: what later.dog can drop, and what it cannot

- **Claude, Codex, Pi and Antigravity:** these engines keep the conversation themselves; later.dog resumes it (for Claude, `--resume` with the session id) and never holds the old screenshots, within a turn or between turns. Nothing is dropped there, and this pull request claims no saving from dropping.
- **Engines later.dog drives over its own chat protocol** (the `openai-chat` driver): later.dog already replaces every older screenshot with a one-line note when a new one arrives (`retireScreenshots` in `server/drivers/chat-images.ts`, called at `server/drivers/openai-chat.ts:716`). Nothing more to build.
- **The saving that does reach every engine** is the smaller picture (B) and fewer pictures (A and C).

## The real-engine command, for the maintainer

On an isolated Linux machine with Xvfb, xdotool, scrot, xclip and Chromium, and a signed-in `claude`:

```sh
xvfb-run -s "-screen 0 1280x800x24" node --experimental-strip-types scripts/browser-steps/real-engine.ts \
  --models claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5 \
  --paths screen,screen-capped,page \
  --out "$HOME/browser-steps-real-$(date +%Y%m%d-%H%M%S)"
```

- Add `structured` to `--paths` and `--engine <pinned agent-browser>` to measure the old agent-browser path too.
- Paths:
  - `screen` is today's tools, with native screenshots.
  - `screen-capped` is later.dog's computer tools now, switch off.
  - `page` is the same tools with the switch on, plus the one added sentence.
- The script prints, per model, path and task: model turns, tool calls, input tokens over all requests, the last request's size, image tokens, tool and wall seconds, and whether the answer was right. It writes every raw turn, `results.json` and `summary.md` into `--out`.

## What only a real engine or a real site can prove

- Whether a model really reads structure first when told to, and really uses `run_actions` and `zoom`.
- The real token counts per model, and the time each call takes over the network to a dog's computer.
- Whether text is readable at 1024 pixels on real pages.
- That the page tools cope with real sites: frames, shadow DOM, very long pages, sign-in walls run by other parties.
- That the page tools work with a live cloud computer's Chromium on port 9339. The fixture used a Chromium started the same way, not the computer image.
- A page's own script can give one of its other elements the same ref, so a `page_click` lands where that page chooses. This stays inside that site's page, much like a misleading layout on the screen.
