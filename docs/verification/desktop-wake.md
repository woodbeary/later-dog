# Sending while the home wakes, measured against a fixture edge

Branch `atelier/desktop-wake-2`. `scripts/desktop-wake.ts` opens the production
renderer build in a headless Chrome and drives it the way a person does (click
the message box, type, press Enter), through `scripts/testing/fixture-edge.ts`,
a stand-in for the edge that sits in front of a home. Behind the fixture edge
is a fake-engine fixture home. Nothing here touches the user's app, home or
data.

Everything in this note is one kind of evidence: measured on the Linux cloud
computer against fixtures. Nothing here was measured on the Mac app, on a real
home, on a real edge or on an iPhone, and no real model was called. Where a
cause is given, it was read in code and says so.

## Run

```sh
pnpm exec vite build
node --experimental-strip-types scripts/desktop-wake.ts \
  --playwright /path/outside/this/checkout \
  --label wake --out .laterdog-scratch/desktop-wake/wake.json \
  --runs 3 --awake-runs 3 --shots .laterdog-scratch/desktop-wake/shots
```

`--playwright` names a folder holding `node_modules/playwright-core`.
`--runs` repeats every case; odd runs use the light theme and even runs the
dark theme, and the first two runs keep pictures under `--shots`.
`--awake-runs` is the number of timed sends in case a per run. `--wake-ms`
(default 5000) is how long the fixture home takes to wake, `--drop-ms`
(default 4000) how long the connection stays down, `--only abc` runs only the
named cases. When a case stops early the harness keeps a picture of the page
and a reading of it next to the result file.

`pnpm vitest run scripts/testing/fixture-edge.test.ts` checks the fixture edge
itself against a stand-in home.

## What is real and what is a fixture

| Part | In this harness |
|---|---|
| Renderer | The real production build, in headless Chrome at 1280 by 800 |
| Home | The real server from this checkout, started as a fixture with the fake engine |
| Engine | `server/testing/fake-claude-cli.ts`: a scripted reply, whole at once unless a case says it streams |
| Edge | `scripts/testing/fixture-edge.ts`: an HTTP server on the same machine. It calls the edge's own functions from `deploy/laterdog/home/src/desk.ts`, `desk-stream.ts` and `waking.ts` for what to hold, what to save, what to answer while the home is not serving, and the event stream it opens itself. The glue around them (when to deliver, the five second retry, the pause between saves) is written again in the fixture after `deploy/laterdog/home/src/host.ts`, not shared with it |
| A home that wakes | A timer in the fixture edge: "stopped", then "starting" for the wake time, then "serving". The home process itself never stops, so nothing here measures a real container starting |
| Network | Loopback. No latency, no TLS, no proxy |
| A refused message | The fixture edge is told to count the next delivery as a 409 without asking the home |
| A hold that runs out | The fixture edge is told the hour has passed; nobody waits an hour |
| A dropped connection | The fixture edge destroys every open socket and refuses new ones for the drop time |

## The cases and what a person waits for

- **a. Send to a home that is awake.** One warm-up send, then the timed sends.
  The person waits for their own words (Row), then for the reply. In run 1 one
  more message gets a reply the engine streams in 12-character pieces every
  100 ms.
- **b. Send while the home is asleep, then it wakes slowly.** The home is
  stopped and set to wake in 5 s; 1.5 s later the person sends. Their words
  show at once as a queued row above the message box with Edit and Delete, the
  box is empty again, and the edge has answered 202. When the home is up the
  edge delivers the message, the row becomes a sent bubble and the reply
  follows. The person waits the rest of the wake, plus the time until the edge
  delivers, plus the reply.
- **c. The connection drops mid-send and comes back.** Three parts. The answer
  to a send is lost before any byte (the home took the message, the socket is
  destroyed). The answer is cut after its first bytes. Then the connection
  drops for 4 s while the dog is replying (that reply streams for about 3 s),
  the person sends another message and types a draft while it is down, and the
  connection comes back. While it is down the new message is a bubble marked
  "Not sent yet". The person waits for the connection, then for the page to
  ask again.
- **d. The home never takes a held message.** Twice: the home refuses the held
  message when it wakes, and the hold runs out. The queued row turns into the
  Not sent row with the words and Retry, under the sentence "Your home never
  took this message, so it was not sent. It is kept below to send again."
  Retry sends it; it is answered once.
- **e. Send now and cancel on a held message.** The dog is working and the
  home is set to wake in 11 s. The held message's row has Send now; pressing
  it answers "Your home is starting. This message sends as soon as it is up."
  and the message stays held. A second held message is deleted from its row
  and never reaches the home. After the wake the first is delivered once.
- **f. The app reloads while a message is held.** The home wakes in 14 s; the
  person sends, then the page is reloaded while the home is still starting.
  The held row is there again with its words, not as Not sent, and is
  delivered once after the wake.
- **g. Three dogs stream replies while the person types in a fourth chat.**
  119 keys at 35 ms, once with no dog working and once while three dogs reply
  in 4-character pieces every 50 ms; then the last word is selected and must
  still be selected, in the same chat, after the three replies finish.
- **h. Typing, drafts and moving between chats while the home wakes.** The
  home wakes in 19 s. The person types a draft, opens another chat, types a
  second draft, comes back, reloads the page, and both drafts must still be in
  their chats.
- **i. The home stops soon after a reply.** A send is answered; the home stops
  right after, and again 8 s after, and wakes in 5 s. The check is whether the
  exchange the person just had is still on screen while the home wakes.

## Numbers

A first complete run, `m1` at 845ea9a (main 89b1439 merged in, before pull
request #173), 3 runs of every case: 363 checks passed, 0 failed, 13 sightings
of 3 known defects. Its tables are in
[`assets/desktop-wake/m1.json`](assets/desktop-wake/m1.json) under `table` and
`otherNumbers`. A second run on the tree with #173 is going; this section is
rewritten from it.

## Done and left

Done:

- Main (8395635, with #173) is merged into the branch.
- Case c stalled because the harness waited for a third reply when two had
  arrived together; fixed in the harness, and case c passed 3 runs of 3 in
  `m1`. It was not a product fault.
- Pull request #174 is open.

Left:

- The run on the tree with #173, its numbers here, the pictures for Atelier,
  the checks with counts, and the write-up of the three known defects (the
  newest exchange leaves the screen while the home wakes; the "kept below"
  sentence stays after Send again; a streamed reply shows nothing until it is
  whole).
