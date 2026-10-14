# Computers and decisions as MCP tools

Added 2026-10-14. later.dog Cloud runs cloud computers and answers quick decisions with Clef. Both are now MCP tools, so any
agent (Claude Code, Codex, a later.dog dog) can run a fast loop: act on a computer, get a screenshot back, and get a
Clef verdict on that screenshot in the same tool result.

There are two ways in, and they expose the same nine tools:

| | Where it runs | Key |
| --- | --- | --- |
| **Remote** | `POST https://cloud.later.dog/mcp` on the computers Worker (`deploy/laterdog/computers`) | The bearer key you already use for the computers API: a free trial or later.dog Cloud key (`ldt_...`), or the operator's `ldc_...` key |
| **Local** | `scripts/mcp-server.ts`, the desktop app's stdio MCP server, as a thin proxy to the same endpoint | The key this Mac already holds (below). No key to paste |

## Add the remote server

The endpoint is JSON-RPC 2.0 over Streamable HTTP: one `POST` per message, a JSON answer, no streaming. Every request needs
`Authorization: Bearer <key>`. The protocol versions it speaks are 2025-03-26, 2025-06-18 and 2025-11-25.

Claude Code:

```sh
claude mcp add --transport http laterdog-cloud https://cloud.later.dog/mcp \
  --header "Authorization: Bearer $(cat ~/.laterdog/computers-trial-key)"
```

That copies the key into Claude Code's own config file. To keep it out of the file, use a `.mcp.json` with
`"headers": { "Authorization": "Bearer ${LATERDOG_COMPUTERS_KEY}" }` and export the variable instead.

Codex:

```sh
export LATERDOG_COMPUTERS_KEY="$(cat ~/.laterdog/computers-trial-key)"
codex mcp add laterdog-cloud --url https://cloud.later.dog/mcp --bearer-token-env-var LATERDOG_COMPUTERS_KEY
```

The key file is where the app keeps the free trial key. If you run your own computers service with an `ldc_` key, put that key in the variable and use your service's origin.

## Use the local server instead

`pnpm mcp` and the bundled `mcp-server.js` (see [the MCP server](../mcp-server.md)) list the same tools after the team
tools. They call the Worker for you with the key the app already holds, so nothing needs pasting, and the key is not copied
into another tool's config. Where they find it is the way the desktop's own server already calls the computers service
(`computersConnection()` and `computersKey()` in `server/laterdog/cloud-computers.ts`): the `computers.json` and
`computers-key` files in the data folder if you run your own service, otherwise the free trial's `computers-trial.json`
and `computers-trial-key`. A Mac with neither gets "later.dog Cloud is not set up on this Mac." as a tool error.

The proxy sends a computer tool's call to the service and nothing else: it never touches the local later.dog server, its
routes or the local-control token, so the allow-list in the MCP server page is unchanged. It checks the arguments first,
refuses a service address that is not HTTPS (or loopback), does not follow redirects, and never prints the key.

## The tools

| Tool | What it does |
| --- | --- |
| `computer_list` | Your computers: id, name, size, state. |
| `computer_create` | A new Linux desktop (Xfce, Chromium, git, Node). `name` and `size` are optional. Size is `small` (standard-1), the default, `standard`, `large` or `xlarge`; a free trial always gets `standard`, so it is the default for a trial key. Returns while the computer is starting. |
| `computer_wake` | Starts a sleeping computer or waits for a new one: returns when it is running and its desktop is drawn, or says it is still starting after 30 seconds and to call again. |
| `computer_sleep` | Snapshots and stops it. Files stay; open programs do not. |
| `computer_screenshot` | The whole screen as a JPEG, pointer included. |
| `computer_action` | `click`, `double_click`, `type`, `key`, `scroll` or `drag` through `xdotool`, then a fresh screenshot and a Clef screen check. |
| `computer_exec` | A shell command (bash, as the desktop user) with `timeout_ms` (1 s to 10 min, default 30 s) and an optional `cwd`. Returns exit code, stdout, stderr, `timedOut` as one JSON text; each stream is cut at 100,000 characters, and says so when it is. |
| `computer_viewer_link` | A signed, expiring link where a person watches the screen and takes over. |
| `decide` | Needs a key with an active later.dog Cloud plan. A Jev-format Clef question: a `state`, one to four `choice`, `score` or `noul` questions, up to four images, and `model` `clef` (default) or `clef-flash`. `computer_id` adds a fresh screenshot as the last image. |

Every tool has a strict schema (no unknown arguments) and every argument problem comes back as a tool error in plain words,
such as `"computer_id" is not in the expected format.` or `click needs x and y.`, so the agent can correct itself.

**Trial computers have open internet access and passwordless root.** Do not put anything on one that you would not hand to a
stranger. `computer_create` says so in its description.

### What `computer_action` returns

One text part (JSON) and one image part. The JSON:

```json
{
  "computer_id": "cmp_abcdefghij23",
  "did": "click at (640, 400)",
  "screen_check": { "screen": "ready", "confidence": 0.97, "changed": 0.95, "matches_expectation": 0.9, "looks": 1 }
}
```

- `screen` is what the screen shows now: `ready`, `loading`, `login`, `two_factor`, `captcha`, `error` or `dialog`.
- `changed` is the probability that the screen changed the way the action would change it (it compares the screenshot from
  before the action with the one after). `matches_expectation` appears when you pass `expect`, plain words for what you expect to see.
- While `screen` is `loading` the tool waits a second and shoots again, up to three more times (`looks` counts the shots).
- On `login`, `two_factor` or `captcha` the result adds `needs_a_person`: use `computer_viewer_link` and let the person sign in.
- Typed text is never sent to the model: the check sees `typed 12 characters`, so a password does not leave the computer
  that way. (It is on the screenshot, though, as text fields show what was typed; see
  [Sign-ins with a Secure Form](cloud-computers.md#sign-ins-with-a-secure-form).)
- If the screen check is not available (an `ldc_` key, no screen checks left today, the model down, a frame too large to send) the action
  still happens and you still get the screenshot; `screen_check` says `{ "unavailable": "<why>" }` instead.

The check is a guess from a small model. It is there to save a round trip, not to replace looking at the screenshot.

## Limits and safety

- **Same key, same limits.** `/mcp` accepts exactly the keys the computers API accepts and refuses a request with an `Origin`
  header. A trial key sees and can use only its own computers (the same registry check as `/v1/computers`), so another key's
  id gets "No computer with that id." Wrong or ended keys get 401 before any body is read.
- **Screen checks have their own budget.** Each shot of `computer_action` that is checked, loading re-shoots included, counts
  one against 1,000 screen checks a day per key and 100,000 in total. It is separate from the 500 a day that room routing
  uses, so a busy agent cannot break routing. When it runs out, `computer_action` still returns the screenshot, with
  `screen_check: { "unavailable": "Today's screen checks are used up..." }`. Only free trial and Cloud keys get screen checks;
  with the operator's `ldc_` key the action runs and returns one screenshot, with no before shot and no check.
- **`decide` is for Cloud plan keys.** It needs a key whose later.dog Cloud plan is active, or cancelled but paid through
  (`plans` row `active` or `canceled`, within its period end plus the grace days, the same signal `GET /v1/trial` reports).
  Any other key, a bare trial key and the `ldc_` key included, gets "Free-form decisions come with the later.dog Cloud plan."
  It has its own budget of 200 a day per key and 20,000 in total (`tool_decisions`). The computer tools stay at parity with
  the REST API for trial keys.
- **Typing.** `text` is at most 1,000 characters and cannot hold a NUL; the command's timeout is 12 ms a character plus 5 s.
- **Errors.** A server-side problem (any 5xx, `container_error`, `start_failed`) reaches the agent as "The computer had a
  problem. Try again in a minute." and the original is logged on the Worker; the few 503s that are plain by design
  (`busy_today`, `not_included`, `trials_off`) keep their words. Other messages are cut at 300 characters.
- **Sizes of things.** A request body is at most 1 MB; `decide` takes at most 24,000 bytes of state, four images of under
  190,000 characters each as data URLs (JPEG, PNG or WebP), 512 KB together, and up to four questions of 600 characters each.
  A screenshot is about 84 KB at 1280x800, which fits; a busy screen that does not fit skips the check but not the screenshot.
- **`/v1/systemone` is unchanged.** It still answers only later.dog's own two questions. Free-form questions are reachable
  only through the `decide` tool, which is behind an active Cloud plan and its own count. Whether to open that is a
  product decision; to close it, remove the `mcp` route (`src/routes.ts`) or `toolDecisionFrom` (`src/decide.ts`).
- **Per-request limits.** `decide` and screen checks also pass the 60 a minute `INCLUDED_LIMIT` per key. The network limit `TRIAL_API_LIMIT` counts each `/mcp` request once, however many steps a tool takes.
- **`computer_exec` and `computer_action` are not read-only.** They are marked destructive and open-world, so clients that
  ask before such tools will ask. Nothing in the tools can reach the person's own Mac, the local later.dog server or any
  other key's data.
- **No streaming.** Long commands hold the request open until they finish or time out. Some MCP clients stop waiting before
  `timeout_ms` does; keep commands short or run them in the background on the computer and read the output later.

## Deploy

See the pull request for the exact steps. In short, only the Worker changes: `pnpm run deploy:worker` in
`deploy/laterdog/computers` (`--containers-rollout=none`, no new image; the container needs `xdotool` and `scrot`, which it already has).

## What was verified, and what was not

Verified, on fakes (`deploy/laterdog/computers/test/mcp*.test.ts`, `server/mcp-computer-tools.test.ts`):

- The protocol: initialize and version negotiation, ping, tools/list, tools/call, notifications, malformed and oversized bodies, unknown tools and methods.
- Auth refusals (no key, wrong key, ended trial, unset secret, `Origin`, GET and the service binding), scoping between two trial keys and the owner, and plain-words errors for every argument problem.
- Each tool through the real Worker, Durable Objects and container fakes: the xdotool command built for each action, quoting of typed text and keys, the loading loop (waits, retries, give-up), a failed action, a failed or unreadable decision, a frame too large to check.
- `decide`: questions, images and model reach the model call; bad questions, models and images are refused before it; `/v1/systemone` still refuses free-form questions.
- The local proxy: the key comes from the saved connection files, the call goes to `/mcp` and nowhere else, error mapping, cancellation, argument checks before any request.

Not verified:

- **Nothing ran against the live service, a real container or the real Clef.** `xdotool` command lines follow its manual and the
  README's examples, but no action has been run on a real computer. The remote server has not been connected from Claude
  Code or Codex (the `claude mcp add` and `codex mcp add` flags were checked against each CLI's help only).
- **Clef's answer shape for the screen check is assumed** from the existing included-decisions tests and Jev's wire format
  (`answers.<id>.choice`, `.probabilities`, `.noul`), and so is how well `clef-flash` tells these screens apart. The tool
  reports `unavailable` for an answer it cannot read.
- Whether MCP clients show the image part of a tool result (Claude Code does; others vary) and how long each waits for a tool.
- Wake times (about 20 seconds in the README's measurements) and the 30-second wait in `computer_wake`.
