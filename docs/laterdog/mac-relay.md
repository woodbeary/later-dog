# Making a Mac's local Dev dogs visible and nudgeable from the phone

Jacob's goal: later.dog Dev, the phone and the notarized build show the same
conversations, so a dog working on this checkout while he's away from his desk
can be watched and nudged from his phone. `fix/one-workspace-everywhere`
solved half of this (Dev shows the Cloud home's chats when connected), but a
dog spawned by Dev's own local engine, in `~/.laterdog-dev`, still only exists
there: the phone and the signed-in later.dog app never see it, because they
only ever talk to the Cloud home's API.

## The two options, and the facts that decide between them

**Option A — the Mac's local workspace joins the home as a connected
computer whose dogs and threads the home relays.** The local engine keeps
doing exactly what it does today: `server/drivers/claude.ts` spawns the real
`claude` CLI with `cwd` on this checkout (`server/cli-setup.ts:122`,
`server/drivers/claude.ts:1331`), with full native Read/Edit/Bash tools, and
stores messages in `~/.laterdog-dev/messages.db` (`server/message-db.ts`).
Only the *visibility* of that conversation moves: a thin bridge carries its
turns through the home, so any screen watching the home sees them.

**Option B — the Cloud home's dogs run their engine on this Mac.** The bot
would live in the home from the start, but its driver would execute by
reaching into the Mac. The home already has exactly one channel for a dog to
touch the Mac: `shared_computer` (`server/drivers/agents-catalog.ts:190`),
dispatched through `/api/internal/shared-computers`
(`server/shared-computers.ts`) to `electron/shared-computer-access.mjs`. It
is real file read/write and shell (`list_files`/`read_file`/`write_file`/
`run_command`, up to 8000 characters per `run_command` call,
`MAX_SHARED_COMMAND` in `server/shared-computers.ts:12`), not mere
screen control — but it is RPC calls a *driver already running elsewhere*
makes into a sandboxed file/shell surface, not a full agentic coding session
with its own native tool loop. Routing Clover's and Finisher's actual coding
turns through it would mean rebuilding their tool use (Read, Edit, Bash,
sub-agents) on top of chunked `read_file`/`write_file`/`run_command` calls —
a rewrite of how local dogs work, with a real capability loss (no direct
filesystem access, 8000-char command chunking, and the automatic
"Let My Cloud use this Mac" grant already lends the *entire* home directory
with write access, `electron/shared-computer-access.mjs:409-429`, wider than
the "never share the whole home folder" rule manually-shared folders get,
`electron/computer-sharing.mjs:73-82` — a second reason not to widen its use).

**Decision: Option A.** It changes nothing about how a local dog runs or what
it can touch; it only adds a relay so the existing, already-working local
conversation is visible and postable from elsewhere. Option B would be a
bigger, riskier rewrite for the same outcome and a capability downgrade for
dogs that are, today, full Claude Code sessions.

## What "relay" has to mean, concretely

Two API facts shape the design (`server/index.ts`):

- Posting a message always starts a turn. `POST /api/bots/:id/messages`
  (`index.ts:16895`) both appends the message and dispatches the bot's
  configured driver in one call (`acceptDirectSend` → `startTurn`,
  `index.ts:7205`, `7531`) — there is no "store this message, don't run
  anything" endpoint. So a mirrored bot in the home cannot just be a dumb
  row the phone appends to; whatever runs when it receives a message has to
  end up, one way or another, asking the Mac.
- Once a message is appended on the home side, visibility is already free:
  `GET /api/events` (`index.ts:14431`) is a long-lived SSE stream that pushes
  every `store.appendMessage` as a `message` event to any connected screen —
  phone and desktop alike. Nothing new is needed there.

So the smallest correct primitive is a small job queue sitting in the home's
server process: a mirrored bot's turn doesn't call an LLM provider, it waits
on a job a connected Mac claims, executes locally (through the local engine's
own `/api/bots/:id/messages`, completely unchanged), and hands the reply
back, which `startTurn` then appends as the bot's answer exactly like a real
driver would have.

## What is built and proven here

Three new, self-contained modules, each covered by vitest (`pnpm exec vitest
run server/laterdog/mac-relay.test.ts server/laterdog/mac-relay-routes.test.ts
scripts/dev-home-relay.test.mjs` — 16 tests, all isolated, no real server or
network):

- `server/laterdog/mac-relay.ts` — `MacRelayQueue`: per-bot FIFO of jobs,
  `requestTurn` (called from `startTurn`'s dispatch point once wired),
  `nextJob`/`completeJob`/`failJob` for the Mac side, and a 10-minute timeout
  with a plain-language offline message when no Mac claims or answers a job.
- `server/laterdog/mac-relay-routes.ts` — the two HTTP handlers a Mac polls:
  `GET` the next job for its bot, `POST` a result or a failure. Bearer-token
  authenticated by whatever the caller passes in (deliberately not wired to
  a specific auth scheme yet — see below).
- `scripts/dev-home-relay.mjs` — the Mac-side bridge: polls the home for a
  job, posts the job's text to the local engine's own `/api/bots/:id/messages`
  (unchanged local behaviour), polls `GET /api/bots` for `busy: false`
  (`shared/wire.ts:202`) then reads the last message, and posts that text
  back to the home. `scripts/dev-home-relay.test.mjs` proves the full round
  trip — a simulated phone nudge enqueued on a fixture "home" reaches a
  fixture "local engine" and the reply flows back to resolve the original
  turn — plus the empty-queue, Mac-never-answers, and long-running-loop
  cases.

## What is not done — the real integration, left for whoever picks this up

- **The `startTurn` branch.** `server/index.ts:7531` picks a driver with
  `registry.get(bot.modelSelection.instanceId)` just before dispatch. Wiring
  Option A for real means adding one branch there, before that line: if
  `bot.modelSelection.instanceId === "mac-relay"`, call
  `queue.requestTurn(botId, threadId, text)` instead of touching the
  registry, and append its result as the bot's reply the same way other
  drivers' results get appended. `server/index.ts` is an 18,000-line file
  central to every turn in the app; this one branch needs someone to trace
  exactly how a driver's successful result is appended (busy-state, activity
  events, error paths) and add it carefully, not under this task's time box.
- **Mounting the two routes** in `server/index.ts`'s router (additive only;
  no risk to existing paths) and giving them real auth — today
  `mac-relay-routes.ts` takes an `authenticate` function as a parameter and
  the tests supply a fake one; the real version should reuse whatever
  authenticates the existing home session bearer tokens the rest of the API
  already checks.
- **Creating the mirrored bot.** Something (Dev's keeper, or a one-time
  `pnpm dev:connect` step) needs to create or find a home bot named for the
  local dog with `modelSelection.instanceId: "mac-relay"`, and tell
  `scripts/dev-home-relay.mjs` that bot's home id and the matching local bot
  id (`LATERDOG_DEV_RELAY_BOT_ID` today is a placeholder env var).
  Keeping one mirrored bot per local bot, rather than one generic "This
  Mac" bot, preserves each dog's own identity, soul and history in the UI.
- **Running the relay script automatically.** Today it's a standalone
  process (`node scripts/dev-home-relay.mjs`); the Dev app's keeper
  (`scripts/dev-app.mjs`) should start and stop it alongside the home proxy
  once the above pieces exist, and `electron/dev-session-menu.mjs` should
  say plainly when a dog is relayed versus running only locally.
- **Phone and desktop verification.** Nothing here was checked against a
  real later.dog Cloud home, a real phone, or a packaged Dev build — only
  the relay mechanism itself, on fixtures, per `docs/verification/README.md`.
