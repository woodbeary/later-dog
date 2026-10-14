# Decision model

later.dog can use a fast decision model to pick things for your bots. It
answers in a few hundred milliseconds for a fraction of a cent. It never does
the work: the chosen bot still runs its own turn on its own engine. The first
supported model is TypeSafe's [Jev](https://typesafe.ai).

Everything is in **Settings → Decision model**: one master switch, the Jev key
with **Save** and **Test**, and one switch per job it can do.

## What it decides today

**Who answers in rooms.** A room whose responder is set to **Auto (Jev)** asks
Jev who should answer each message that @mentions nobody. The question offers
the room's active bots, each described by name, title and description, plus
"several members". The state it reads is the room's name, its people, the last
room lines (the same window room turns use, clipped in size) and the new
message.

- If one bot comes back with a probability of at least 0.6, only that bot
  answers.
- If "several members" comes back at 0.6 or above, every member answers.
- Anything less sure goes to the room's fallback: the lead it had before it
  became Auto, or else its first member. That is what a lead-mode room does
  today.

@mentions, `@everyone`, team goals and the other responder modes never ask
Jev. The message is appended and the send returns straight away; the answer
is awaited only when the room's turn starts, within 1.5 seconds.

A reply whose speaker Jev picked shows a small line under it: *Picked by
Jev · 94%*.

New rooms start on Auto while the decider and its room job are on. Existing
rooms keep their mode. With Jev off, an Auto room shows a one-line hint and
answers like lead mode.

Browser clicks, tool selection and where work runs are listed as "Coming
soon" and have no switch yet.

## It fails open

The decision model never blocks or delays a turn beyond its short budget.
With no key, the switch off, the job off, a timeout, a network error, an HTTP
error (401, 429, 529, 5xx), or an answer that does not check out (a choice
that was not offered, a probability that is not a number), the room does
exactly what it would have done without it. Every answer is validated before
it is used.

## What is logged

Each call that reaches the model adds one row to
`~/.laterdog/decider-log/YYYY-MM.ndjson` (mode 0600). This is separate
from the approvals log in `decisions/`.

```json
{"at":"…","seam":"roomRouting","provider":"jev","ok":true,"choice":"<bot id>","pTop":0.94,"margin":0.9,"latencyMs":341,"inputTokens":712,"stateHash":"3f1c…"}
```

A row never holds the message text, the bots' descriptions or the key; a
16-character hash of the state is enough to spot repeats. Failed calls record
the reason (`timeout`, `overloaded`, …) and the HTTP status. Month files are
kept for the approvals log's retention window (180 days by default).
The log stays on this machine: workspace backups leave it out.

## Where the key lives

- **Desktop app:** in the operating system's encrypted store
  (`credentials.bin`), like the other workspace keys. The server receives it
  as `LATERDOG_JEV_API_KEY` at start-up; `config.json` keeps only an empty
  placeholder.
- **Server or browser use:** in the server's own `config.json` (mode 0600),
  under `decider.key`. `LATERDOG_JEV_API_KEY` overrides it.
- **Cloud Pro:** decisions are included, with no key to paste. With no key of
  the person's own, the Cloud home uses its relay token
  (`LATERDOG_CLOUD_DECIDER_TOKEN`), sent only to the Admin's relay, never to Jev
  or `baseUrl`, and only for room routing and the key check (other jobs need
  a key of the person's own). Settings says **Included with your Cloud plan**, and
  the master switch is on until someone switches it off. A key saved here
  always wins; clearing it falls back to the included decisions. See
  [cloud-pro.md](cloud-pro.md), "Included Boat computers, voice and
  decisions".

The key is write-only: `GET /api/config` reports only whether one is saved
and which switches are on. Engines never inherit it, and diagnostics exports
mask it. Saving a key makes one tiny test call; a key Jev rejects is not
saved. The **Test** button makes the same call on demand. A room decision
costs about $0.00003; the test call costs less.

## Turning it off

Switch off **Use Jev for fast decisions**, or clear the key (on Cloud Pro,
clearing a key falls back to the included decisions: switch off to stop
them). To keep Jev on but stop room routing, switch off **Who answers in
rooms**. To stop one room asking, set its responder to a lead, **Everyone
responds** or **Only when mentioned**.

## Configuration reference

```json
"decider": {
  "enabled": true,
  "provider": "jev",
  "key": "",
  "baseUrl": "https://api.typesafe.ai",
  "jobs": { "roomRouting": true }
}
```

`baseUrl` points at a Jev-compatible server instead of TypeSafe's. It has no
Settings UI. It must be https, or http to this machine only. Requests go to
`{baseUrl}/v1/systemone` with model `jev-latest`.

## Measuring it

`server/decider/room-routing.eval.test.ts` replays 53 labelled room messages
(`server/decider/fixtures/room-routing.json`) against the live model. It is
skipped unless `LATERDOG_JEV_LIVE_EVAL=1` is set with a key, and costs about
$0.002 per run.

## Fast decisions with Clef (Auto-review, Keep going, Screen check, Screenshot filter)

Cloudflare's Clef models answer the same typed questions as Jev, and also read
up to four images. Four extra jobs use them. Every one is **off until it is
switched on** in Settings, Auto-review, and each switch says what it sends
and where. Nothing is generated: a job asks, reads a probability, and a slow or
failing decider only ever means today's behaviour.

| Job | Sends | Does |
| --- | --- | --- |
| Auto-review | the action's kind and a short description (secrets removed, 600 characters per field) and your rules | A clear match to a go-ahead rule approves with a grey line; a clear match to an ask-first rule pauses the action with a grey line; anything else shows the card |
| Keep going | the task, the dog's last reply and its last eight steps | A dog that stopped midway (0.8 or more) is nudged with "Keep going until it's done.", at most 3 in a row |
| Screen check | cloud-computer screenshots (and the one before it) | Waits for a loading page, flags sign-in and captcha screens, says whether the last action changed anything |
| Screenshot filter | the final screenshot of a turn | Posts it to the chat only when it is worth showing and no secret is likely |

Rules that bind:

- Go-ahead rules never apply to anything that always asks (messages sent for
  you, the local computer, requests with their own choices), to Off-leash or
  Custom requests, or to an action whose text was cut short for the question.
  A block rule that is the top answer, at any strength, means no auto-approval.
  An approval also needs a second answer, 0.9 or more, that the action stays
  entirely within the rule that was picked.
- Ask-first rules are also checked in Full access and for saved commands
  and web searches.
- Auto-review is limited to 30 reviews a minute per dog. Past that, the card
  shows as before.
- Each job has a 1.5 s budget that covers preparing the image and the call.
  A screen check is capped at about 3 s in total, and the final screenshot is
  filtered after the turn has settled, so it never delays it. After three
  failures in a row a job is skipped for 60 s.
- Changing these from a script on this machine, while a dog is working, is
  refused when it would loosen things: a new go-ahead rule, a removed ask-first
  rule, or a job switched on. The app and paired devices can.

Models: `decider.model` picks one model for everything, `decider.models`
picks per job. With neither, an included or custom endpoint uses `clef` for
Auto-review, Screen check and Screenshot filter and `clef-flash` for Keep going;
the TypeSafe endpoint keeps `jev-latest` and cannot read images. The included
Cloud relay only accepts room routing today, so these jobs do nothing there
until it accepts their questions.

Every Keep going, Screen check and Screenshot filter outcome is one line in
`~/.laterdog/clef-log/YYYY-MM.ndjson` (no text, no images). Auto-review
outcomes are in the approvals log with source `auto-review`.

### Measured

`node --experimental-strip-types scripts/laterdog-clef-bench.ts`
runs 34 labelled states (14 screenshots in `scripts/testing/clef-bench/`, 10
turn endings, 10 approval requests) through the same code the app uses. It
reads `LATERDOG_DECIDER_URL` and `LATERDOG_DECIDER_KEY` from the environment
only; `--dry` runs against a fake backend, `--only autoReview --json` adds
every case with what was expected and what came back.

Live run on 2026-10-14, measured from a Mac through a dev proxy to Workers AI
(a temporary forwarding Worker under `wrangler dev --remote`, so every time
includes the hop from the Mac to the edge and runs a little slower than the
Cloud relay will). 3 runs of each state, one at a time, no failures:

| Model | Job | Accuracy | Median ms | p95 ms |
| --- | --- | --- | --- | --- |
| clef | Auto-review | 90% (27/30) | 270 | 452 |
| clef | Screen check, loading / showing | 100% / 100% | 406 | 684 |
| clef | Screenshot filter, secret / worth | 93% / 100% | 387 | 656 |
| clef | Keep going | 100% | 274 | 609 |
| clef-flash | Auto-review | 90% (27/30) | 281 | 449 |
| clef-flash | Screen check, loading / showing | 100% / 93% | 513 | 1303 |
| clef-flash | Screenshot filter, secret / worth | 100% / 86% | 603 | 1071 |
| clef-flash | Keep going | 100% | 204 | 781 |

That is why `clef` is the default for the three jobs that read images or
guard an action, and `clef-flash` for Keep going: `clef-flash` is faster only
for Keep going, and is less accurate on the screen jobs.

Which 3 of the 30 Auto-review verdicts were wrong is not recorded: that run
printed only the totals. The bench now labels each wrong verdict as a false
allow, a false block, a missed allow, a missed block or the wrong rule, and
prints them under the table. Run
`LATERDOG_DECIDER_URL=... LATERDOG_DECIDER_KEY=... node --experimental-strip-types scripts/laterdog-clef-bench.ts --only autoReview --models clef`
to list them. Those numbers were also measured before the second-opinion
check (a 0.9 yes that the action stays entirely within the chosen rule) was
added to Auto-review, so they are expected to move.
