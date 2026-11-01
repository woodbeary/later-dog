# Claude computer use in later.dog's own loop

Added 2026-10-31. The supervisor can do a task on a later.dog cloud computer with Claude computer use, in a loop
later.dog runs itself: it calls the Messages API, carries out each action on the computer, logs every step in its own
store, and decides that a run is done only by a rule the run fixed before it started.

The code is in `server/laterdog/computer-use-*.ts`. The numbers it produces are defined in [../metrics.md](../metrics.md).

This is a cloud path: it drives a later.dog cloud computer with the same `xdotool` and `scrot` its
[computer tools](computer-tools.md) use. Computer use on the person's own Mac stays on the local driver in
[../computer-use-integration.md](../computer-use-integration.md).

## What a run does

1. The person starts a run with a task, a cloud computer and a done rule (`POST /v1/computer-runs`).
2. later.dog reads the computer's screen size (`xdotool getdisplaygeometry`), works out the screenshot size, captures a
   first frame and sends the task with that frame.
3. Claude answers with computer actions. later.dog runs them in order on the computer (one `xdotool` command each,
   through the computers API's `exec`), maps every point from screenshot pixels to screen pixels, and answers every call
   with a `tool_result`: the image for `screenshot`, `OK` for the rest, an error in plain words when an action fails.
4. That repeats until Claude ends its turn, the person takes over or ends the run, or a limit is reached.

Along the way the person gets the screen whenever it needs them: a signed viewer link on every take-over, a Secure Form
for sign-ins, and a hold before anything that submits, pays, publishes, cancels or deletes (below).

## One pinned model, and the tool version

| | |
| --- | --- |
| Model | `claude-opus-5-5` at effort `medium`, in `COMPUTER_USE_MODEL` and `COMPUTER_USE_EFFORT` (`computer-use-anthropic.ts`) |
| Tool | `{"type": "computer_toolset_20260801", "configs": {"zoom": {"enabled": false}}}`, plus later.dog's own `request_takeover`, `request_secure_form` and `fill_secure_field` tools |
| Thinking | `{"type": "adaptive", "display": "summarized"}`; the summary is kept per step |
| Headers | `anthropic-version: 2023-06-01` and the key in `x-api-key`. No beta header: the toolset is generally available on the Claude API |

The tool version and the image rules below come from Anthropic's computer use tool documentation
(<https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>, read on 2026-10-31). It says the
Claude 5.5 models take computer use only through `computer_toolset_20260801` on the Claude API and return an error for
the earlier tool versions; the toolset takes no tool name and no display size, each call is a `tool_use` block named after
the member (`left_click`, `type`, `screenshot` and so on) with `"toolset_name": "computer"`, and every result must echo
that `toolset_name`. later.dog withholds `zoom` because the cloud desktop cannot crop a frame yet; a `zoom` call gets an
error result.

The run records the model it started on. The loop refuses to run when its client is pinned to another model, and fails
the run if an answer names a different one (a dated name of the same model, such as `claude-opus-5-5-20261015`, is the
same model). Refusal fallbacks to other models are deliberately left off, so a run never
changes model: a declined request ends the run with the cause `refusal`.

Several calls in one turn run in order and stop at the first failure; each later call gets
`Not executed: an earlier computer action in this turn failed.`, as the documentation asks.

## Screenshot size

What the documentation says for the toolset models:

- An image may be at most 2,576 pixels on its long edge and 4,784 visual tokens (`⌈width / 28⌉ × ⌈height / 28⌉`).
  The API does not shrink a screenshot, and rejects one that is too large.
- 1280x800 or 1366x768 suit web applications; resolutions above 1920x1080 are best avoided.
- Claude's coordinates are pixels of the screenshot it was sent. If the screenshot was scaled, scale them back before acting.

What later.dog does (`computer-use-frame.ts`):

- A screen that fits in 1920x1080 (1080x1920 when it stands upright) is sent at its own size. later.dog's cloud desktop
  is 1280x800, so its frames go as they are and every point maps one to one.
- A larger screen is shrunk to fit that box with its shape kept, for example 2560x1600 to 1728x1080. Every such frame is
  inside both limits above, and a test checks the limits for screens up to 7680x4320.
- Every point Claude names is mapped back to the screen and clamped to it; `cursor_position` answers in screenshot pixels.
  A test maps the four corners and the center of each shrunk size to the screen and back, and gets the same points.
- On the cloud computer a shrunk frame is scrot's own thumbnail (`scrot --thumb WxH`), read back through the files API.

## The step log

Everything is kept in the supervisor's `workspace.sqlite`, the same store that holds cloud jobs, in three tables.

`computer_use_runs`: one row per run, with the task, computer, model, the done rule as it was when the run started, the
state (`running`, `handed_over`, `awaiting_done`, `submission_unknown`, `done`, `failed`), the done source or failure
cause, the times, and whether the run had screen checks (`screen_checks`).

`computer_use_steps`: one row per step. A step is one Messages API call and the actions it asked for. A step that the
run ends partway through (the person says Done or stops it, the supervisor stops, or another model answers) is still
written, with the actions it had reached and that call's tokens.

| Column | What it holds |
| --- | --- |
| `actions` | Each action as Claude asked for it: the member name and its input, in screenshot pixels. Typed text is kept as its length only |
| `screenshot_sha256` | SHA-256 of the screenshot Claude was looking at when it chose these actions (the latest frame it had been sent) |
| `model_ms` | Time from sending the request to having the answer |
| `action_ms` | Time spent carrying out the actions, not counting time the screen was with the person |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | The answer's `usage` |
| `screen_state`, `screen_probability` | The screen check's reading of the frame Claude chose from, when screen checks are on |
| `outcome` | `submission_unknown` when a guarded action ran but no confirmation was seen (below) |
| `thinking` | Claude's summarized thinking for the step |
| `screen_unchanged` | 1 when the next screenshot after the step's first action was the same as the frame before it |
| `failure_class` | Set only by the person's review: `stale_screenshot`, `missed_click`, `wrong_field`, `page_not_settled`, `gave_up` or `environment` |

Secure Form calls are kept as their name, the number of fields asked for and the outcome (`filled`, `cancelled`,
`refused`, `typed`, `not typed`). No value, label or site is logged.

`computer_use_handoffs`: one row per take-over, with its cause, who asked (`model`, `person`, `screen_check` or `guard`),
the check's probability when a check asked, the step it was for, the viewer link and its expiry while the screen is with
the person, and when the screen came back. The link itself is cleared when the screen comes back; its expiry is kept.

`computer_use_events` is a view over the three tables with the names `task_started`, `handoff`, `handed_back`,
`submission_unknown`, `task_done` and `task_failed`.

`GET /v1/computer-runs/<id>` returns the run, its steps, its take-overs and any Secure Form waiting for the person.
`GET /v1/computer-runs/<id>/trace` returns the same run to share: the task, Claude's reasoning and the take-over notes
are replaced by their SHA-256, as screenshots already are, and no viewer link is in it.

## Take over

- Claude asks for the person with `request_takeover`, naming one step and a reason: `sign-in`, `captcha`, `payment` or
  `other`. It is told to fill in everything else on the page first.
- The person can also take the screen at any time (`POST …/take-over`, with an optional `cause` and `note`; the cause is
  `person` unless they give one).
- While the person has the screen nothing is sent to Claude and no action runs; calls already in the turn are answered
  as not executed. When the person hands back (`POST …/hand-back`) Claude is told to take a fresh screenshot first.
- Every take-over mints the computer's signed viewer link (`POST /computers/:id/desktop` on the computers API: HMAC over
  the computer, its boot generation and the expiry, two hours). It is returned by the take-over route and the run view
  while the screen is with the person. A link that is not https (such as `http://computers.internal` from a cloud
  supervisor without `LATERDOG_COMPUTERS_PUBLIC_URL`) is not handed out. If no link can be minted the take-over still
  happens, without one.
- Every take-over, and every Secure Form, is pushed to the phones registered with the supervisor
  (`POST /v1/computer-runs/phone-push`), naming the run. The push never carries the viewer link: the phone reads it from
  the run view with the supervisor's token, so it never passes through the push service.
- Time with the person counts toward neither `action_ms` nor the run's working time.

## Secure Form

Claude signs in the way dogs do ([`../../server/laterdog/secure-form.ts`](../../server/laterdog/secure-form.ts)):

1. It opens the sign-in page and calls `request_secure_form` with a title, the site's host and the fields (email or
   username, password, code). The run waits; the run view shows the form, and the phone gets a push.
2. The person fills it in with `POST /v1/computer-runs/<id>/secure-form` `{ "formId", "values": { … } }`, or closes it with
   `{ "formId", "cancel": true }`. The values stay in the supervisor's memory only, are never echoed back, and are wiped
   ten minutes after they are sent, two minutes after the last field is typed, or when the run ends.
3. Claude calls `fill_secure_field` with the form, the field and the field's position in screenshot pixels. later.dog maps
   the point to the screen and runs secure-form.ts's checked command: the browser must be the active window, on https at
   the form's host, the point below the toolbar, and focus unchanged; it types by pasting and then clears the clipboard.
   A field is typed three times at most. Claude never sees a value.

## Screen checks, the guard, and unknown submits

With `LATERDOG_SCREEN_CHECKS=on` the loop asks `clef-flash` about the screen through the computers Worker's
supervisor-only route `POST /v1/screen-checks` (the owner `ldc_` key or the service binding; AI Gateway log off). Each run
records whether it had them. Off, none of the following happens.

- **A second take-over trigger.** Every frame Claude is sent is read as `ready`, `loading`, `login`, `two_factor`,
  `captcha`, `error` or `dialog`, and the reading is kept on the step. When Claude clicks, types or presses keys on a frame
  read as `login`, `two_factor` or `captcha` (probability 0.5 or more) without first asking for the person, a Secure Form
  or a take-over, the loop hands the screen over itself (`asked_by = screen_check`, cause `sign-in` or `captcha`, with the
  probability) and runs nothing more in that turn. A screen already handed over, or one Claude asked about, is not handed
  over again until a frame reads differently. Looking, waiting and moving the pointer never trigger it.
- **The guard.** Before a left click, and before Enter, the loop crops 480x240 around the target with
  `scrot --autoselect` (the whole frame for Enter) and asks whether the action would submit, pay, publish, cancel or
  delete something. On yes, or when the check cannot answer, the screen goes to the person (`asked_by = guard`, cause
  `confirm`) and the action runs only if they hand back with `{ "approve": true }`; otherwise Claude is told it did not run.
  The Enter that `fill_secure_field` presses after a sign-in is not guarded.
- **Unknown submits.** After an approved action, the loop looks for a confirmation three times over about six seconds.
  If the desktop failed during the action, or no look confirms it, the step's outcome is `submission_unknown`. Claude is
  told "Do not repeat it", the rest of the batch does not run, and the loop refuses every further guarded action in the
  run. The page check and the state check are tried at once; if one passes the run is done. Otherwise, when Claude ends
  its turn the run waits in `submission_unknown` for the person, and counts as failed until they settle it.

## Done

Each run says what done means before it starts, in `done.pageCheck`, and the run keeps that rule:

- `null`: only the person can say the run is done.
- `{ "url": "https://…", "contains": "…" }`: the run is also done when that page answers with a 2xx status and contains
  the text. later.dog fetches it when Claude says it is finished. The address must be https (or loopback http) with no
  credentials in it.

`done.stateCheck` is optional, in the same shape: the run is also done when the desktop's own browser has, in its active
tab, an address starting with `url` and a page containing the text. It works behind a sign-in, where the supervisor's
fetch cannot. later.dog runs one command on the computer: a small Node script reads the tab over Chromium's DevTools port
on 127.0.0.1:9222 (with no Origin header) and prints only the address without its query and whether it matched, never the
page's text. The active tab is the one whose title the active window shows; when it cannot be told apart from other tabs
(several tabs, no matching title), the check does not pass and the person decides. The page check is tried first, then
the state check.

Claude has no way to finish a run. When it ends its turn, a passing page check or state check makes the run `done` with
the source `page_check` or `state_check`; otherwise the run waits in `awaiting_done` (or `submission_unknown`) for the
person to say Done or Not done. The person can say Done at any time. A run fails, with its cause, when the person says it is not done (`not_done`), stops it (`stopped`), Claude
declines (`refusal`), it reaches 100 steps (`step_limit`) or 30 minutes of working time (`timed_out`), the API or the
computer fails (`error`), or the supervisor restarts during it (`interrupted`). A run waiting for the person survives a
restart.

None of this is open to a dog: the supervisor refuses every `/v1/computer-runs` route to a dog's token.

## Routes

All on the supervisor, with its own token.

| Route | What it does |
| --- | --- |
| `POST /v1/computer-runs` | Start a run: `{ "task", "computerId", "done": { "pageCheck": null \| { "url", "contains" }, "stateCheck"?: null \| { "url", "contains" } } }`. One run at a time on a computer: 409 while another is going on it |
| `GET /v1/computer-runs` | The latest 50 runs |
| `GET /v1/computer-runs/<id>` | One run with its steps, its take-overs and any Secure Form waiting for the person |
| `POST /v1/computer-runs/<id>/done` | The person says it is done |
| `POST /v1/computer-runs/<id>/not-done` | The person says it is not done |
| `POST /v1/computer-runs/<id>/stop` | Stop the run |
| `POST /v1/computer-runs/<id>/take-over` | The person takes the screen: `{ "cause"?, "note"? }`. Answers `{ run, handoff }` with the viewer link |
| `POST /v1/computer-runs/<id>/hand-back` | The person hands the screen back: `{ "approve"?: true }` lets a held guarded action run |
| `POST /v1/computer-runs/<id>/secure-form` | The person fills in the waiting Secure Form, `{ "formId", "values" }`, or closes it, `{ "formId", "cancel": true }` |
| `GET /v1/computer-runs/<id>/trace` | The run to share, hashed (above) |
| `POST /v1/computer-runs/<id>/steps/<n>/failure-class` | The review's label for a step: `{ "failureClass": … \| null }` |
| `POST`, `DELETE /v1/computer-runs/phone-push` | Register or remove a phone's push token `{ "token" }` |

## Set it up

The supervisor needs `ANTHROPIC_API_KEY` in its environment. Calls are billed to that key per token. It reaches the
cloud computers the same way cloud jobs do (`LATERDOG_COMPUTERS_URL`, `LATERDOG_COMPUTERS_KEY`). Without the key, the
routes answer 409 with what is missing.

- Screen checks, the guard and the screen trigger: set `LATERDOG_SCREEN_CHECKS=on` after the computers Worker with
  `POST /v1/screen-checks` is deployed in full. Before that, every guarded action would wait for the person, because the
  guard cannot get an answer.
- The state check needs the computers image that opens the loopback DevTools port, which also takes a full deploy of the
  computers Worker (its container image changes).
- The cloud supervisor's Worker passes `ANTHROPIC_API_KEY` and `LATERDOG_SCREEN_CHECKS` to its container when they are set
  (`deploy/laterdog/cloudflare/src/supervisor-env.ts`): set the key as a secret, then deploy that Worker in full.

### DevTools in the desktop's browser

The computers image starts Chromium with `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` for the
state check, and its policy blocks the browser's own pages from opening `127.0.0.1:9222`, `localhost:9222` and
`0.0.0.0:9222`, so Claude cannot reach the port from the screen. Without `--remote-allow-origins`, Chromium refuses a
DevTools WebSocket from any web page. Chromium's policy `DeveloperToolsAvailability: 2` would also close the DevTools
window and console to the screen, but Chromium's own policy definition says it applies to direct DevTools Protocol
access too ("when launched with --remote-debugging-port"), so it would turn the state check off. It is not set; choosing
between the two is the person's call.

```sh
curl -sS -X POST "$SUPERVISOR/v1/computer-runs" -H "authorization: Bearer $SUPERVISOR_TOKEN" -H 'content-type: application/json' \
  -d '{"task":"Open later.dog and find the pricing page","computerId":"cmp_…","done":{"pageCheck":null}}'
```

## What was verified, and what was not

Verified on fixtures, with a fake desktop and scripted Messages answers (`server/laterdog/computer-use-*.test.ts`):
screenshot sizes and limits, mapping points both ways, every toolset member and its `xdotool` command, typed text kept
out of the shell and out of the log, the request body and headers, one retry on 429 and 5xx, the step log (including a
step the run ends partway through), take-overs asked by Claude and taken by the person, every way a run ends, the page
check, one run at a time on a computer, the routes for the person and for a dog, and every query in
[../metrics.md](../metrics.md).

Verified once on an isolated supervisor process (`node --experimental-strip-types server/laterdog/main.ts` with its own
data folder and token) wired to a fake computers API and a fake Messages API on loopback: a run clicked, typed and
pressed Return through `exec`, asked for the person, waited 11 seconds in `handed_over` (left out of `action_ms`),
resumed when handed back, took a screenshot through the files API, ended its turn into `awaiting_done`, and became
`done` from the person only; a dog's token got 403 on the Done route. Stopping the supervisor during a take-over
failed that run as `interrupted`, and the restarted supervisor reported it so. To repeat it, set `LATERDOG_ANTHROPIC_URL`
to the fake's address; the supervisor accepts only a loopback `http://` address there, so a real key can only ever reach
Claude's API.

Verified on 2026-11-01 the same way, against fakes of the computers API (exec, files, the viewer link and
`/v1/screen-checks`) and of the Messages API on loopback, with `LATERDOG_SCREEN_CHECKS=on`: Claude asked for a Secure
Form, the person filled it in through the route (the response held no value), both values were typed through the checked
command and neither appeared in any Messages request or the step log; the guard asked about a crop around each left
click, held the Submit click with a signed viewer link on the take-over, and ran it once after the person approved; no
confirmation was seen, so the step became `submission_unknown`, Claude's second Submit was refused without running, and
the state check settled the run as `done` with the source `state_check`. In a second run Claude clicked on a frame read as
`login` without asking, and the loop handed the screen over (`asked_by = screen_check`) without running the click. The
hashed trace held no task text, viewer link or reasoning. Every request carried summarized adaptive thinking and the four
tools.

Not verified:

- **Nothing ran against the live API, a real computer or the real Clef.** The request shape follows the documentation;
  whether the API accepts it as sent (including `strict` on `request_takeover` beside the toolset, top-level
  `cache_control`, adaptive thinking with a summarized display, and the Secure Form tools' schemas) waits for the first run
  with a real key. How well `clef-flash` tells a Submit button from others, and a confirmation from an error, is unmeasured.
- The computers Worker with `/v1/screen-checks`, and the image with the DevTools port, are not deployed. Whether this
  Chromium opens the DevTools port on its default profile directory has not been checked on the image.
- `scrot --autoselect` and the state check script have not run on a cloud computer.
- The `xdotool` commands and scrot's thumbnail name (`frame-thumb.jpg`) have not run on a cloud computer. The default
  1280x800 desktop never needs the thumbnail.
- There is no screen in the app or the phone yet for Done, Not done, Take over, Hand back, the viewer link or the Secure
  Form; they are supervisor routes. The phone app does not yet open a run from a push.
- Every screenshot stays in the conversation, so a long run sends more each step. Prompt caching is on to keep that
  cheap; how well it hits is not measured.
