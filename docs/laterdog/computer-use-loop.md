# Claude computer use in later.dog's own loop

Added 2026-10-31. The supervisor can do a task on a later.dog cloud computer with Claude computer use, in a loop
later.dog runs itself: it calls the Messages API, carries out each action on the computer, logs every step in its own
store, and decides that a run is done only by a rule the run fixed before it started.

The code is in `server/laterdog/computer-use-*.ts`. The numbers it produces are defined in [../metrics.md](../metrics.md).

## What a run does

1. The person starts a run with a task, a cloud computer and a done rule (`POST /v1/computer-runs`).
2. later.dog reads the computer's screen size (`xdotool getdisplaygeometry`), works out the screenshot size, captures a
   first frame and sends the task with that frame.
3. Claude answers with computer actions. later.dog runs them in order on the computer (one `xdotool` command each,
   through the computers API's `exec`), maps every point from screenshot pixels to screen pixels, and answers every call
   with a `tool_result`: the image for `screenshot`, `OK` for the rest, an error in plain words when an action fails.
4. That repeats until Claude ends its turn, the person takes over or ends the run, or a limit is reached.

## One pinned model, and the tool version

| | |
| --- | --- |
| Model | `claude-opus-5-5` at effort `medium`, in `COMPUTER_USE_MODEL` and `COMPUTER_USE_EFFORT` (`computer-use-anthropic.ts`) |
| Tool | `{"type": "computer_toolset_20260801", "configs": {"zoom": {"enabled": false}}}`, plus later.dog's own `request_takeover` tool |
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
- On the cloud computer a shrunk frame is scrot's own thumbnail (`scrot --thumb WxH`), read back through the files API.

## The step log

Everything is kept in the supervisor's `workspace.sqlite`, the same store that holds cloud jobs, in three tables.

`computer_use_runs`: one row per run, with the task, computer, model, the done rule as it was when the run started, the
state (`running`, `handed_over`, `awaiting_done`, `done`, `failed`), the done source or failure cause, and the times.

`computer_use_steps`: one row per step. A step is one Messages API call and the actions it asked for.

| Column | What it holds |
| --- | --- |
| `actions` | Each action as Claude asked for it: the member name and its input, in screenshot pixels. Typed text is kept as its length only |
| `screenshot_sha256` | SHA-256 of the screenshot Claude was looking at when it chose these actions (the latest frame it had been sent) |
| `model_ms` | Time from sending the request to having the answer |
| `action_ms` | Time spent carrying out the actions, not counting time the screen was with the person |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | The answer's `usage` |

`computer_use_handoffs`: one row per take-over, with its cause, who asked (`model` or `person`), the step it was for, and
when the screen came back.

`GET /v1/computer-runs/<id>` returns the run, its steps and its take-overs together: that is the run's trace.

## Take over

- Claude asks for the person with `request_takeover`, naming one step and a reason: `sign-in`, `captcha`, `payment` or
  `other`. It is told to fill in everything else on the page first.
- The person can also take the screen at any time (`POST …/take-over`, with an optional `cause` and `note`; the cause is
  `person` unless they give one).
- While the person has the screen nothing is sent to Claude and no action runs; calls already in the turn are answered
  as not executed. When the person hands back (`POST …/hand-back`) Claude is told to take a fresh screenshot first.
- Time with the person counts toward neither `action_ms` nor the run's working time.

## Done

Each run says what done means before it starts, in `done.pageCheck`, and the run keeps that rule:

- `null`: only the person can say the run is done.
- `{ "url": "https://…", "contains": "…" }`: the run is also done when that page answers with a 2xx status and contains
  the text. later.dog fetches it when Claude says it is finished. The address must be https (or loopback http) with no
  credentials in it.

Claude has no way to finish a run. When it ends its turn, a passing page check makes the run `done` with the source
`page_check`; otherwise the run waits in `awaiting_done` for the person to say Done or Not done. The person can say Done
at any time. A run fails, with its cause, when the person says it is not done (`not_done`), stops it (`stopped`), Claude
declines (`refusal`), it reaches 100 steps (`step_limit`) or 30 minutes of working time (`timed_out`), the API or the
computer fails (`error`), or the supervisor restarts during it (`interrupted`). A run waiting for the person survives a
restart.

None of this is open to a dog: the supervisor refuses every `/v1/computer-runs` route to a dog's token.

## Routes

All on the supervisor, with its own token.

| Route | What it does |
| --- | --- |
| `POST /v1/computer-runs` | Start a run: `{ "task", "computerId", "done": { "pageCheck": null \| { "url", "contains" } } }` |
| `GET /v1/computer-runs` | The latest 50 runs |
| `GET /v1/computer-runs/<id>` | One run with its steps and take-overs |
| `POST /v1/computer-runs/<id>/done` | The person says it is done |
| `POST /v1/computer-runs/<id>/not-done` | The person says it is not done |
| `POST /v1/computer-runs/<id>/stop` | Stop the run |
| `POST /v1/computer-runs/<id>/take-over` | The person takes the screen: `{ "cause"?, "note"? }` |
| `POST /v1/computer-runs/<id>/hand-back` | The person hands the screen back |

## Set it up

The supervisor needs `ANTHROPIC_API_KEY` in its environment. Calls are billed to that key per token. It reaches the
cloud computers the same way cloud jobs do (`LATERDOG_COMPUTERS_URL`, `LATERDOG_COMPUTERS_KEY`). Without the key, the
routes answer 409 with what is missing.

```sh
curl -sS -X POST "$SUPERVISOR/v1/computer-runs" -H "authorization: Bearer $SUPERVISOR_TOKEN" -H 'content-type: application/json' \
  -d '{"task":"Open later.dog and find the pricing page","computerId":"cmp_…","done":{"pageCheck":null}}'
```

## What was verified, and what was not

Verified on fixtures, with a fake desktop and scripted Messages answers (`server/laterdog/computer-use-*.test.ts`):
screenshot sizes and limits, mapping points both ways, every toolset member and its `xdotool` command, typed text kept
out of the shell and out of the log, the request body and headers, one retry on 429 and 5xx, the step log, take-overs
asked by Claude and taken by the person, every way a run ends, the page check, the routes for the person and for a dog,
and every query in [../metrics.md](../metrics.md).

Verified once on an isolated supervisor process (`node --experimental-strip-types server/laterdog/main.ts` with its own
data folder and token) wired to a fake computers API and a fake Messages API on loopback: a run clicked, typed and
pressed Return through `exec`, asked for the person, waited 11 seconds in `handed_over` (left out of `action_ms`),
resumed when handed back, took a screenshot through the files API, ended its turn into `awaiting_done`, and became
`done` from the person only; a dog's token got 403 on the Done route. Stopping the supervisor during a take-over
failed that run as `interrupted`, and the restarted supervisor reported it so. To repeat it, set `LATERDOG_ANTHROPIC_URL`
to the fake's address; the supervisor accepts only a loopback `http://` address there, so a real key can only ever reach
Claude's API.

Not verified:

- **Nothing ran against the live API or a real computer.** The request shape follows the documentation; whether the API
  accepts it as sent (including `strict` on `request_takeover` beside the toolset, and top-level `cache_control`) waits
  for the first run with a real key.
- The `xdotool` commands and scrot's thumbnail name (`frame-thumb.jpg`) have not run on a cloud computer. The default
  1280x800 desktop never needs the thumbnail.
- There is no screen in the app yet for Done, Not done, Take over and Hand back; they are supervisor routes.
- Every screenshot stays in the conversation, so a long run sends more each step. Prompt caching is on to keep that
  cheap; how well it hits is not measured.
