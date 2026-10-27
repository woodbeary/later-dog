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
back, which the home saves as the bot's answer exactly like a real driver's.

## How it works

- **The engine.** `server/drivers/mac-relay.ts` is a driver like any other,
  listed in `BUILT_IN_DRIVERS`. On a Cloud home, `instanceConfigs`
  (`server/config.ts`) adds a `mac-relay` instance, so `startTurn` dispatches
  a mirrored dog through the registry with no special case. Its `sendTurn`
  emits `turn.started`, waits on `MacRelayQueue.requestTurn`
  (`server/laterdog/mac-relay.ts`), then emits the reply as the dog's answer,
  or the failure, which the event consumer saves and streams like any turn.
  A job nobody claims or answers fails after 10 minutes with a plain message
  saying the Mac isn't relaying.
- **The mirrors.** `server/laterdog/mac-relay-mirrors.ts` keeps one home dog
  per local dog, mapped in `mac-relay-mirrors.json` in the home's data
  folder. A mirror has the local dog's name, title, description and colour,
  runs on `mac-relay`, starts with no greeting and has no cloud computer.
  Deleting a mirror on the home makes the next sync create a fresh one.
- **The routes** (`server/routes/mac-relay.ts`, only on a Cloud home, only for
  the owner's own signed-in session):
  - `PUT /api/mac-relay/mirrors/:localBotId` creates or updates a mirror and
    answers `{ botId, created }`.
  - `GET /api/mac-relay/bots/:botId/job` leases the next job for a mirror.
  - `POST /api/mac-relay/jobs/:jobId/result` with `{ text }`, or
    `.../fail` with `{ message }`, finishes it.
- **The Mac side.** `scripts/dev-home-relay.mjs <session> <localUrl>` syncs
  mirrors for every local dog every 30 seconds, polls each mirror's job every
  2 seconds, posts the job's text into the local dog's own main thread, waits
  for a new text answer from that dog once it is no longer busy, and posts it
  back. Dogs are relayed in parallel, one job per dog at a time.
- **later.dog Dev.** When Dev is connected to the home
  (`LATERDOG_DEV_HOME_SESSION`), `scripts/dev-desktop.mjs` now runs the local
  engine on Dev's second server port (18999, webhook 19000, supervisor 9110)
  on `~/.laterdog-dev`, plus the relay, beside the home proxy on 8999.

## Proof

- `scripts/mac-relay.e2e.test.ts` launches two isolated fixtures, a Cloud
  home and a Mac engine with a scripted engine reply, pairs three sessions on
  the home (relay, phone, desktop), syncs mirrors, sends a message from the
  phone session to the mirrored dog, and checks that the Mac dog got the
  words and answered, and that the answer shows in the home thread for the
  phone and the desktop and on the desktop's live event stream.
- `server/routes/mac-relay.test.ts`, `server/laterdog/mac-relay-mirrors.test.ts`,
  `server/laterdog/mac-relay.test.ts`, `scripts/dev-home-relay.test.mjs` and
  `scripts/dev-desktop.node-test.mjs` cover the pieces.

## Not proven

Nothing here was checked against Jacob's real Cloud home, his phone or the
installed later.dog Dev app. The home side ships only with a Cloud home image
that includes these changes.
