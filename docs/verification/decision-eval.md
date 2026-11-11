# Decision and extraction model evaluation, 2026-11-10

Clef and Clef-flash were asked bounded-choice, ranking and yes-or-no triage
questions in the wire format the product's typed decisions path already sends.
Clairic was asked, separately, for typed fields out of short texts. Every
fixture is synthetic. Each model answer is compared with a deterministic rule
on the same item.

## Decision

No product behaviour changes in this pull request. Room routing already uses
Clef behind its fallback, and the results support leaving it exactly as it is.
Nothing else is integrated.

| Use | Model | Decision | Why, in the numbers |
|---|---|---|---|
| Group chat routing (bounded choice), already in the product | Clef | Keep as it is | 43 of 43 scored messages right through the later.dog relay (95% interval 91.8% to 100%) against 11 of 43 for the rule. At the product's 0.6 threshold it answered 41, all right, and handed 2 to the fallback. Median 394 ms, p95 1,155 ms, 1 of 53 past the 1,500 ms deadline. $0.11 per 1,000 decisions. 53 relay receipts. |
| Group chat routing | Clef-flash | Do not switch to it | 41 of 43 right (84.5% to 98.7%). One of its two misses came with confidence 0.859, so the 0.6 threshold would have sent it to the wrong dog. It is 120 ms faster at the median and saves $0.09 per 1,000 decisions, which is not worth a wrong dog. Against Clef the split is 2 to 0, which 43 messages cannot tell apart from chance (0.5). 53 relay receipts. |
| Heavy-command triage (yes or no) | Clef | Do not integrate | 142 of 142 right (97.4% to 100%) against 118 of 142 for the shipped rule, but the answer takes 408 ms at the median and 879 ms at p95, with 2 of 142 past 1,500 ms, on a check that runs before a dog's shell command. The relay allows 500 decisions a day per key and accepts only room routing, so most commands would get the rule anyway. All 24 rule misses are command shapes a rule can name. 142 direct Workers AI receipts, none through the relay. |
| Heavy-command triage | Clef-flash | Do not integrate | 127 of 142 right (83.3% to 93.5%); it missed 15 of 77 heavy commands. Against the rule the split is 18 to 9, which could be chance (0.12). 142 direct receipts. |
| Waiting on the owner (yes or no) | Clef, Clef-flash | Do not integrate | Each 69 of 70 right (92.3% to 99.7%) against 57 of 70 for a rule written for this evaluation. The product does not ask this question of a message's words: it reads the cards and the state a dog records. There is nothing to put a model behind. 70 direct receipts each. |
| Picking a dog for a request (ranking) | Clef, Clef-flash | Do not integrate | Each 40 of 40 right (91.2% to 100%) against 29 of 40 for a word-overlap rule written for this evaluation. The only product use of this shape is room routing, which is covered above. 40 direct receipts each. |
| Reset time out of a provider's limit message (typed extraction) | Clairic | Do not integrate | Alone it got 39 of 42 right (81.0% to 97.5%) against 26 of 42 for the shipped rule; its three misses were two right clock times put on the wrong day and one timestamp it could not read. Used only where the rule finds nothing it was right on 25 of 25, so the pair got 42 of 42. But times, dates and numbers came back with no source span (0 of 111), so a wrong time cannot be checked against the text, and the product has no path to Clairic. 42 direct receipts. |
| Amounts and dates out of short texts, and computed values | Clairic | Do not integrate | Amounts 24 of 24, dates 23 of 24, computed values 10 of 12. No product feature reads these today. 36 direct receipts. |

What would change these decisions is listed under [Left](#left).

## Where each number comes from

Four kinds of evidence are kept apart in this note.

1. **Provider receipts from real model calls.** 914 calls, made on 2026-11-10
   between 17:46 and 17:52 Pacific, saved unedited on the branch
   `atelier/decision-eval-receipts`.

   | File | Calls | Answered | Path |
   |---|---|---|---|
   | `responses-mac.json` | 688 | 688 | Workers AI REST, called from Jacob's Mac with its Wrangler sign-in: 305 Clef, 305 Clef-flash, 78 Clairic |
   | `responses-relay.json` | 106 | 106 | The later.dog relay, called from the Cloud home, room routing only: 53 Clef, 53 Clef-flash |
   | `responses-relay-first-pass.json` | 106 | 70 | The same relay calls before the retry; 36 were refused with HTTP 429 |
   | `probe-deadline.json` | 10 | 0 | Clef-flash with a 100 ms deadline |
   | `probe-invalid.json` | 4 | 0 | Requests built wrong on purpose: 2 to Clef, 2 to Clairic |

   No calls were made after that. Nothing was bought again for this note.
2. **Rule results from fixtures.** Each rule's answers, the paired counts and the
   rule timings are computed from the fixtures by `scripts/decision-eval`. The
   rule timings and the probe replay ran on the Linux cloud computer on
   2026-11-11.
3. **Read in code only.** The relay's limits (500 decisions a day per key,
   100,000 a day in total, in `deploy/laterdog/computers/src/decide.ts`), the
   relay accepting only room routing and the key check
   (`server/decider/relay.ts`), the 1,500 ms deadline and the 0.6 threshold
   (`server/decider/room-routing.ts`), and what a room does on a fallback (it
   uses the responders it would have used without routing, `server/index.ts`).
   Prices are the listed input rates recorded in
   [consolidation-release-2026-11-08.md](consolidation-release-2026-11-08.md):
   Clef $0.24, Clef-flash $0.038, Clairic $0.10 per million input tokens. Cost
   per decision is that rate times the input tokens each receipt reports; every
   receipt reports zero output tokens. No bill was read.
4. **Not measured.** Listed under [Not measured](#not-measured).

## Fixtures

All synthetic, each labelled once by the helper that wrote it. No message,
command or account detail from Jacob's home is in them.

| Case | Shape | Items | Scored | Rule it is compared with |
|---|---|---|---|---|
| roomRouting | Choice among the room's dogs or everyone | 53 | 43 (10 are meant for nobody and are not scored) | The one dog the message names, else the first dog in the room. A stand-in for the room's default responder, written for the evaluation. |
| heavyCommand | Yes or no | 142 (77 yes, 65 no) | 142 | `heavyCommandKind`, the rule the product ships |
| waitingOnOwner | Yes or no | 70 (35 yes, 35 no) | 70 | A closing question mark or a request phrase. Written for the evaluation. |
| dogRanking | Choice among 8 dogs, with a first choice and an accepted set | 40 | 40 | The dog whose title and description share the most words with the request. Written for the evaluation. |
| resetTime | Clairic fields: time, date, zone, wait | 42 (9 with no reset in them) | 42 | `parseResetWords` and `resetInstant`, the rule the product ships |
| shortText | Clairic fields: amount, date | 24 | 24 | A plain money and date pattern. Written for the evaluation. |
| computed | Clairic field worked out from the text, 7 also as an estimate | 12 | 12 | None |

The room routing fixture is the one already in `server/decider/fixtures`. The
other four were written for this evaluation.

Read the rule columns with this in mind:

- The heavy-command fixture includes 23 commands picked because the shipped rule
  misses them. The rule's 83.1% is its score on this fixture, not its rate on
  the commands dogs run.
- Three of the rules were written for the evaluation and are simple on purpose.
  A model beating them shows the model can do the task. It does not show the
  product loses anything today.
- One labeller, no second opinion, one answer per item per model per path.

## Clef and Clef-flash: summary

Accuracy, with the 95% Wilson interval, and the paired comparison with the rule
on the same items. The last column is the exact two-sided chance of a split at
least this uneven if model and rule were equally good.

| Case | Model | Receipts | Scored | Model right | 95% interval | Rule right | Only the model right | Only the rule right | Chance |
|---|---|---|---|---|---|---|---|---|---|
| roomRouting, relay | Clef | 53 | 43 | 43 (100%) | 91.8% to 100% | 11 (25.6%) | 32 | 0 | under 0.0001 |
| roomRouting, relay | Clef-flash | 53 | 43 | 41 (95.3%) | 84.5% to 98.7% | 11 (25.6%) | 30 | 0 | under 0.0001 |
| heavyCommand, direct | Clef | 142 | 142 | 142 (100%) | 97.4% to 100% | 118 (83.1%) | 24 | 0 | under 0.0001 |
| heavyCommand, direct | Clef-flash | 142 | 142 | 127 (89.4%) | 83.3% to 93.5% | 118 (83.1%) | 18 | 9 | 0.12 |
| waitingOnOwner, direct | Clef | 70 | 70 | 69 (98.6%) | 92.3% to 99.7% | 57 (81.4%) | 13 | 1 | 0.0018 |
| waitingOnOwner, direct | Clef-flash | 70 | 70 | 69 (98.6%) | 92.3% to 99.7% | 57 (81.4%) | 13 | 1 | 0.0018 |
| dogRanking, direct | Clef | 40 | 40 | 40 (100%) | 91.2% to 100% | 29 (72.5%) | 11 | 0 | 0.0010 |
| dogRanking, direct | Clef-flash | 40 | 40 | 40 (100%) | 91.2% to 100% | 29 (72.5%) | 11 | 0 | 0.0010 |

The 106 room routing calls sent direct from the Mac returned the same answer,
to the last digit, as the 106 sent through the relay. They are one measurement
of accuracy and two of latency, so the relay rows are the ones shown here.

Clef against Clef-flash on the same items: room routing 2 to 0 (chance 0.5),
heavy commands 15 to 0 (under 0.0001), waiting on the owner 1 to 1, ranking no
difference. Clef-flash is measurably worse only on heavy commands.

Ranking: Clef put the labelled first-choice dog first on 40 of 40 (mean
reciprocal rank 1.000), Clef-flash on 39 of 40 (0.988).

Which side the yes-or-no misses fell on:

- heavyCommand: Clef missed 0 of 77 heavy and flagged 0 of 65 light. Clef-flash
  missed 15 of 77 heavy and flagged 0 of 65 light. The rule missed 23 of 77 and
  flagged 1 of 65.
- waitingOnOwner: Clef said yes to 1 of 35 that are no. Clef-flash said no to 1
  of 35 that are yes. The rule said no to 11 of 35 that are yes and yes to 2 of
  35 that are no.

Messages meant for nobody: the question offers no such answer, so the model
must pick someone. On the 10 such messages Clef answered 7 at 0.6 or above and
Clef-flash 3. The product then sends the message to that dog; on a fallback it
goes to the default responder. Neither is right for these messages.

### Calibration

Confidence is the probability the model gave its own answer. A lower Brier
score is better. The calibration error is the average gap between confidence
and the share right, over the bins in the full table below.

| Case | Model | Scored | Brier score | Calibration error | Lowest confidence band with a wrong answer |
|---|---|---|---|---|---|
| roomRouting | Clef | 43 | 0.017 | 0.087 | none wrong |
| roomRouting | Clef-flash | 43 | 0.056 | 0.092 | under 0.5 (1 of 4 wrong); also 0.8 to 0.9 (1 of 11 wrong) |
| heavyCommand | Clef | 142 | 0.012 | 0.087 | none wrong |
| heavyCommand | Clef-flash | 142 | 0.078 | 0.075 | 0.5 to 0.6 (5 of 13 wrong), up to 0.8 to 0.9 (1 of 31 wrong) |
| waitingOnOwner | Clef | 70 | 0.009 | 0.060 | 0.5 to 0.6 (1 of 1 wrong) |
| waitingOnOwner | Clef-flash | 70 | 0.021 | 0.085 | 0.7 to 0.8 (1 of 4 wrong) |
| dogRanking | Clef | 40 | 0.008 | 0.055 | none wrong |
| dogRanking | Clef-flash | 40 | 0.023 | 0.096 | none wrong |

Both models are under-confident where they are right: Clef's answers at 0.8 to
0.9 were right 58 of 58 times across the four cases. Clef-flash's confidence on
heavy commands does track being right (61.5% right at 0.5 to 0.6, 100% at 0.9
and above), which is why a threshold helps it there. With one or zero wrong
answers in a case there is little to calibrate against; these tables show no
over-confidence, not a proven calibration.

### Abstaining

Abstaining means the model's answer is used only at or above a confidence
threshold and the rule answers the rest. The cost is the answers handed to the
rule. The saving is the wrong model answers that no longer go out. The last
column is the share right for model and rule together. Every threshold is in
the full table below; these are the rows that matter.

| Case | Model | Threshold | Model answers | Handed to the rule | Wrong model answers still sent | Right, model and rule together |
|---|---|---|---|---|---|---|
| roomRouting, relay | Clef | 0.5 | 43 of 43 | 0 | 0 | 100% |
| roomRouting, relay | Clef | 0.6 (the product's) | 41 of 43 | 2 | 0 | 95.3% |
| roomRouting, relay | Clef | 0.9 | 32 of 43 | 11 | 0 | 81.4% |
| roomRouting, relay | Clef-flash | 0.6 | 39 of 43 | 4 | 1 | 88.4% |
| roomRouting, relay | Clef-flash | 0.9 | 26 of 43 | 17 | 0 | 72.1% |
| heavyCommand | Clef | 0.8 | 135 of 142 | 7 | 0 | 100% |
| heavyCommand | Clef | 0.9 | 93 of 142 | 49 | 0 | 88.0% |
| heavyCommand | Clef-flash | 0.5 | 142 of 142 | 0 | 15 | 89.4% |
| heavyCommand | Clef-flash | 0.7 | 115 of 142 | 27 | 4 | 91.5% |
| heavyCommand | Clef-flash | 0.9 | 67 of 142 | 75 | 0 | 85.9% |
| waitingOnOwner | Clef | 0.6 | 69 of 70 | 1 | 0 | 100% |
| waitingOnOwner | Clef-flash | 0.8 | 65 of 70 | 5 | 0 | 95.7% |
| dogRanking | Clef | 0.8 | 39 of 40 | 1 | 0 | 100% |
| dogRanking | Clef-flash | 0.8 | 35 of 40 | 5 | 0 | 95.0% |

For Clef, abstaining saved almost nothing because it was almost never wrong,
and every answer handed to a weaker rule cost accuracy. For room routing the
product's 0.6 threshold handed 2 right answers to the fallback and stopped no
wrong one on this fixture. That is 43 messages; it is not grounds to move the
threshold. For Clef-flash on heavy commands, no threshold got the pair above
91.5%.

### Latency and cost

Each call was sent on its own, one after another, 50 ms apart. Latency is the
whole round trip seen by the caller.

| Model | Path | Calls | Median ms | p95 ms | Worst ms | Past the 1,500 ms deadline |
|---|---|---|---|---|---|---|
| Clef | later.dog relay from the Cloud home | 53 | 394 | 1,155 | 3,308 | 1 |
| Clef-flash | later.dog relay from the Cloud home | 53 | 274 | 687 | 1,269 | 0 |
| Clef | Workers AI REST from the Mac | 305 | 413 | 876 | 3,297 | 3 |
| Clef-flash | Workers AI REST from the Mac | 305 | 274 | 478 | 1,420 | 0 |
| Clairic | Workers AI REST from the Mac | 78 | 319 | 442 | 507 | 0 |

The rules answer in microseconds: median 3.8 µs for room routing, 1.3 µs for
heavy commands, 0.2 µs for waiting on the owner and 21.6 µs for ranking, 200
timed passes over each fixture on the cloud computer.

| Case | Mean input tokens | Clef, $ per decision | Clef-flash, $ per decision |
|---|---|---|---|
| roomRouting | 439 | 0.0001055 | 0.0000167 |
| heavyCommand | 216 | 0.0000518 | 0.0000082 |
| waitingOnOwner | 221 | 0.0000530 | 0.0000084 |
| dogRanking | 423 | 0.0001015 | 0.0000161 |

Clairic: 356 input tokens and $0.0000356 per call on average, over 78 receipts.

## Clairic: typed extraction

78 direct receipts, all 78 valid typed answers.

| Task | Receipts | Model right | 95% interval | Rule right | Notes |
|---|---|---|---|---|---|
| Reset as a wall-clock time | 42 | 39 (92.9%) | 81.0% to 97.5% | 26 (61.9%, 46.8% to 75.0%) | Model: 3 wrong times, 0 invented, 0 missed. Rule: 0 wrong, 16 missed. Only the model right 16, only the rule right 3, chance 0.0044. |
| Reset, rule first and the model only where the rule finds nothing | 42 | 42 (100%) | 91.6% to 100% | | The model was asked to stand in on 25 texts and was right on all 25 (86.7% to 100%), 9 of them correctly empty. |
| Amount in a short text | 24 | 24 (100%) | 86.2% to 100% | 18 (75.0%) | Rule: 2 wrong, 4 missed. |
| Date in a short text | 24 | 23 (95.8%) | 79.8% to 99.3% | 21 (87.5%) | Model missed 1. Rule missed 3. |
| Computed value | 12 | 10 (83.3%) | 55.2% to 95.3% | none | Estimates: the true value fell between the 10th and 90th percentile on 6 of 7. |

Confidence and abstaining. Clairic reports, for each field, a confidence and a
chance that the field is empty. Mean confidence was 0.945 when right and 0.701
when wrong. The three wrong reset times:

- r007 and r033 give a clock time and no date. The model read the time right
  (confidence 1.00) and filled in tomorrow's date (confidence 0.73 and 0.66,
  chance of empty 0.06 and 0.32), which put the reset a day late.
- r032 is a bare epoch timestamp, the older message form. The model returned a
  wrong time with confidence 0.02. The shipped rule reads this form.

Dropping any field whose chance of being empty is above 0.05 fixed both date
misses and cost no right answer: 41 of 42. At 0.1 it fixed one (40 of 42), at
0.5 and above neither (39 of 42). A cut on confidence, which would drop r032,
was not scored.

Source evidence. Text fields came back with a character span: 23 of 23 text
answers had one and every span read back as the value. Times, dates, numbers
and durations came back with no span: 0 of 111. For the fields the product
would use, the evidence Jacob asked for is not there. 11 of 15 amounts returned
are written as digits in the text, which a caller can check for itself.

Field by field, the reset date was filled in on 22 texts that give no date and
the time zone on 10 that name none. The wall-clock score above does not depend
on those fields being empty; anything that reads them one by one would.

## Failure probes

These three failures must never hold up a message. The decider reports each as
a reason and the caller uses its rule. Each saved receipt was replayed through
`createDecider` on the cloud computer with a stand-in for the network that
returns what the provider returned.

| What happened | Receipts | From | What the decider reported | Rule answered instead | Rule right, where labelled |
|---|---|---|---|---|---|
| Quota: HTTP 429 from the relay, "Too many requests from this network", after 68 calls in 47 seconds | 36 | Real, later.dog relay | `rate_limited` | 36 of 36 | 8 of 29 |
| Deadline: no answer inside 100 ms | 10 | Real, Workers AI REST | `timeout` | 10 of 10 | 10 of 10 |
| Bad request: no questions (HTTP 400), one option only (HTTP 422) | 2 | Real, Workers AI REST | `http_error` | 2 of 2 | not labelled |
| Bad answer: not an object, no answer, a probability above 1, a choice not offered, probabilities short of 1 | 5 | Made up, no model call | `malformed` | 5 of 5 | 4 of 5 |
| Bad request to Clairic: no fields, unknown field type (both HTTP 400) | 2 | Real, Workers AI REST | not replayed: the product has no Clairic path | | |

No real answer failed the product's schema check: 716 of 716 Clef and
Clef-flash answers and 78 of 78 Clairic answers parsed. The bad-answer row is
therefore made up, and says so.

The refused relay calls came back in 9 to 17 ms. The retried pass answered all
106. In the product a refused routing call is not retried: the room uses its
default responder for that message.

Where this sits in the product (read in code, and covered by tests): room
routing is asked after the message is saved, with a 1,500 ms
deadline, and any failure returns `fallback` with its reason. This pull
request adds `rate_limited` to the list of reasons the routing test covers.

## Not measured

- Clef and Clef-flash through the relay on anything but room routing. The
  relay refuses other questions, so the heavy-command, waiting and ranking
  receipts are direct Workers AI calls. Their accuracy carries over; their
  latency is the Mac's network, not the Cloud home's.
- A home using its own Jev key. That path calls a different model, and this
  evaluation has no receipts for it.
- Clairic through any later.dog path. There is none.
- Repeat calls. Each item was asked once per model per path. The two paths
  returned identical room routing answers, which suggests answers are stable,
  on 106 pairs.
- Real conversations, real commands or real limit messages. Fixtures only.
- Load. Calls were sent one at a time; nothing here says what latency does
  when many dogs ask at once.
- The quota itself. The 429s are a per-network rate limit met by the test
  harness. The daily allowance of 500 was not reached.
- Nothing here needed the Mac or an iPhone again, and nothing was observed on
  the real home.

## Checks run

On the Linux cloud computer, 2026-11-11, Node 24.22.2, on the branch after
merging `origin/main` (c96ea63):

| Check | Result |
|---|---|
| `vitest run scripts/decision-eval server/decider` | 7 files passed, 1 skipped; 126 tests passed, 1 skipped. By file: `scripts/decision-eval/decision-eval.test.ts` 25, `server/decider/decider.test.ts` 59, `room-routing.test.ts` 11, `auto-room-compat.test.ts` 9, `decider-config.test.ts` 6, and the two decider end-to-end files the pattern also matches, 10 and 6. Skipped: `room-routing.eval.test.ts`, which makes live calls only when given a key. |
| `pnpm typecheck` | Exit 0 |
| `vitest run scripts/no-comments.test.ts scripts/brand-links.test.ts` | 2 files, 13 tests passed (10 and 3), over the 3,771 tracked files with this note among them. The cloud copy carries no git history, so the file list the two tests read was rebuilt there from this branch's `git ls-files`. |

The first two rows ran before this note was written; the note changes no code.

## Reproduce

```sh
node scripts/decision-eval.ts plan --out requests.json
node scripts/decision-eval/call.mjs --target workers-ai --account-id ACCOUNT --wrangler-config PATH --requests requests.json --out responses-mac.json
node scripts/decision-eval/call.mjs --target relay --relay URL --token-env TOKEN --groups roomRouting --requests requests.json --out responses-relay.json
node scripts/decision-eval.ts score --responses responses-mac.json,responses-relay.json
node scripts/decision-eval.ts rules --repeats 200
node scripts/decision-eval.ts probes --responses responses-relay-first-pass.json,probe-deadline.json,probe-invalid.json
```

`plan` writes 688 requests. `score`, `rules` and `probes` make no network
calls; `score` and `rules` run with Node alone, `probes` needs the repository's
packages installed. To re-score without buying anything, take the receipt
files from `atelier/decision-eval-receipts`.

## Done

- Fixtures, harness, metrics and scoring, with tests.
- 914 receipts saved and scored.
- Failure probes replayed through the product's decider.
- The heavy-command rule change that was committed here by mistake (b6b042e)
  was reverted on this branch (c8d4f87). The diff against main touches only
  `scripts/decision-eval`, this note and one line of
  `server/decider/room-routing.test.ts`.

## Left

- Heavy commands: the reverted rule change scores 142 of 142 on this fixture,
  but it was written after the fixture, so that is not an independent test. It
  is in this branch's history only (b6b042e) and is in no pull request. Put it
  up on its own, with commands it has not seen.
- Clairic for reset times would be worth a second look if three things change:
  typed fields carry a source span, the relay gains an extraction route with
  its own allowance, and the two day-late answers are understood. Until then
  nothing changes where the rule finds no reset time.
- Room routing has no answer for "nobody". Adding one changes the question the
  relay accepts, so it needs a relay release and a fresh set of receipts.
- A second labeller and a larger room routing set would narrow the intervals.
  With 43 messages, 100% right still allows a true rate as low as 91.8%.

## Full tables

Harness output, unedited, from the receipts above.

### Receipts scored

| Receipts from | Calls | First | Last |
|---|---|---|---|
| Workers AI REST from the Mac | 688 | 2026-11-11T01:46:25.482Z | 2026-11-11T01:51:16.195Z |
| later.dog relay from the Cloud home | 106 | 2026-11-11T01:46:36.009Z | 2026-11-11T01:50:20.470Z |

### Accuracy against the labelled outcome

| Case | Model | Receipts from | Model right | Model 95% interval | Rule right | Rule 95% interval | Model right where the rule is wrong | Rule right where the model is wrong | Both wrong | Chance of a split this uneven if the two were equal |
|---|---|---|---|---|---|---|---|---|---|---|
| dogRanking | clef | Workers AI REST from the Mac | 40 of 40 (100.0%) | 91.2% to 100.0% | 29 of 40 (72.5%) | 57.2% to 83.9% | 11 | 0 | 0 | 0.0010 |
| dogRanking | clef-flash | Workers AI REST from the Mac | 40 of 40 (100.0%) | 91.2% to 100.0% | 29 of 40 (72.5%) | 57.2% to 83.9% | 11 | 0 | 0 | 0.0010 |
| heavyCommand | clef | Workers AI REST from the Mac | 142 of 142 (100.0%) | 97.4% to 100.0% | 118 of 142 (83.1%) | 76.1% to 88.4% | 24 | 0 | 0 | under 0.0001 |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 127 of 142 (89.4%) | 83.3% to 93.5% | 118 of 142 (83.1%) | 76.1% to 88.4% | 18 | 9 | 6 | 0.1221 |
| roomRouting | clef | later.dog relay from the Cloud home | 43 of 43 (100.0%) | 91.8% to 100.0% | 11 of 43 (25.6%) | 14.9% to 40.2% | 32 | 0 | 0 | under 0.0001 |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 41 of 43 (95.3%) | 84.5% to 98.7% | 11 of 43 (25.6%) | 14.9% to 40.2% | 30 | 0 | 2 | under 0.0001 |
| roomRouting | clef | Workers AI REST from the Mac | 43 of 43 (100.0%) | 91.8% to 100.0% | 11 of 43 (25.6%) | 14.9% to 40.2% | 32 | 0 | 0 | under 0.0001 |
| roomRouting | clef-flash | Workers AI REST from the Mac | 41 of 43 (95.3%) | 84.5% to 98.7% | 11 of 43 (25.6%) | 14.9% to 40.2% | 30 | 0 | 2 | under 0.0001 |
| waitingOnOwner | clef | Workers AI REST from the Mac | 69 of 70 (98.6%) | 92.3% to 99.7% | 57 of 70 (81.4%) | 70.8% to 88.8% | 13 | 1 | 0 | 0.0018 |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 69 of 70 (98.6%) | 92.3% to 99.7% | 57 of 70 (81.4%) | 70.8% to 88.8% | 13 | 1 | 0 | 0.0018 |

dogRanking, clef, Workers AI REST from the Mac: first choice is the primary dog 100.0%, mean reciprocal rank 1.000.

dogRanking, clef-flash, Workers AI REST from the Mac: first choice is the primary dog 97.5%, mean reciprocal rank 0.988.

heavyCommand, clef, Workers AI REST from the Mac: the model said no to 0 of 77 that are yes and yes to 0 of 65 that are no, the rule said no to 23 of 77 that are yes and yes to 1 of 65 that are no.

heavyCommand, clef-flash, Workers AI REST from the Mac: the model said no to 15 of 77 that are yes and yes to 0 of 65 that are no, the rule said no to 23 of 77 that are yes and yes to 1 of 65 that are no; wrong: h002 (0.536), h003 (0.734), h004 (0.847), h010 (0.522), h011 (0.55), h014 (0.638), h015 (0.669), h020 (0.682), h021 (0.734), h024 (0.686), h025 (0.559), h055 (0.682), h065 (0.65), h066 (0.775), h068 (0.542).

roomRouting, clef, later.dog relay from the Cloud home: 10 messages meant for nobody are not scored, and 7 of them were answered at 0.6 or above.

roomRouting, clef-flash, later.dog relay from the Cloud home: 10 messages meant for nobody are not scored, and 3 of them were answered at 0.6 or above; wrong: rh05 (0.391), rh13 (0.859).

roomRouting, clef, Workers AI REST from the Mac: 10 messages meant for nobody are not scored, and 7 of them were answered at 0.6 or above.

roomRouting, clef-flash, Workers AI REST from the Mac: 10 messages meant for nobody are not scored, and 3 of them were answered at 0.6 or above; wrong: rh05 (0.391), rh13 (0.859).

waitingOnOwner, clef, Workers AI REST from the Mac: the model said no to 0 of 35 that are yes and yes to 1 of 35 that are no, the rule said no to 11 of 35 that are yes and yes to 2 of 35 that are no; wrong: n005 (0.565).

waitingOnOwner, clef-flash, Workers AI REST from the Mac: the model said no to 1 of 35 that are yes and yes to 0 of 35 that are no, the rule said no to 11 of 35 that are yes and yes to 2 of 35 that are no; wrong: w034 (0.796).

| Case | Rule right | Rule wrong on |
|---|---|---|
| roomRouting | 11 of 43 (25.6%) | r02, r03, r04, r05, r06, r11, r12, r14, r15, r18, r19, r20, r22, r24, r25, r28, r29, r30, r32, r33, r34, rh01, rh02, rh03, rh05, rh06, rh07, rh09, rh11, rh12, rh13, rh14 |
| heavyCommand | 118 of 142 (83.1%) | h012, h013, h014, h015, h016, h017, h019, h020, h021, h030, h031, h034, h035, h036, h041, h052, h066, h067, h068, h070, h071, h073, h076, l006 |
| waitingOnOwner | 57 of 70 (81.4%) | w002, w006, w011, w013, w015, w020, w024, w027, w031, w032, w035, n009, n035 |
| dogRanking | 29 of 40 (72.5%) | k006, k007, k008, k030, k032, k033, k036, k037, k038, k039, k040 |

### Calibration

| Case | Model | Receipts from | Scored | Brier score | Expected calibration error |
|---|---|---|---|---|---|
| dogRanking | clef | Workers AI REST from the Mac | 40 | 0.008 | 0.055 |
| dogRanking | clef-flash | Workers AI REST from the Mac | 40 | 0.023 | 0.096 |
| heavyCommand | clef | Workers AI REST from the Mac | 142 | 0.012 | 0.087 |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 142 | 0.078 | 0.075 |
| roomRouting | clef | later.dog relay from the Cloud home | 43 | 0.017 | 0.087 |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 43 | 0.056 | 0.092 |
| roomRouting | clef | Workers AI REST from the Mac | 43 | 0.017 | 0.087 |
| roomRouting | clef-flash | Workers AI REST from the Mac | 43 | 0.056 | 0.092 |
| waitingOnOwner | clef | Workers AI REST from the Mac | 70 | 0.009 | 0.060 |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 70 | 0.021 | 0.085 |

| Case | Model | Receipts from | Confidence | Answers | Mean confidence | Right |
|---|---|---|---|---|---|---|
| dogRanking | clef | Workers AI REST from the Mac | 0.5 to 0.6 | 1 | 0.555 | 1 of 1 (100.0%) |
| dogRanking | clef | Workers AI REST from the Mac | 0.8 to 0.9 | 4 | 0.876 | 4 of 4 (100.0%) |
| dogRanking | clef | Workers AI REST from the Mac | 0.9 to 0.95 | 6 | 0.927 | 6 of 6 (100.0%) |
| dogRanking | clef | Workers AI REST from the Mac | 0.95 to 1 | 29 | 0.972 | 29 of 29 (100.0%) |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0 to 0.5 | 2 | 0.489 | 2 of 2 (100.0%) |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.6 to 0.7 | 1 | 0.654 | 1 of 1 (100.0%) |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.7 to 0.8 | 2 | 0.781 | 2 of 2 (100.0%) |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.8 to 0.9 | 6 | 0.866 | 6 of 6 (100.0%) |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.9 to 0.95 | 9 | 0.925 | 9 of 9 (100.0%) |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.95 to 1 | 20 | 0.972 | 20 of 20 (100.0%) |
| heavyCommand | clef | Workers AI REST from the Mac | 0.6 to 0.7 | 3 | 0.658 | 3 of 3 (100.0%) |
| heavyCommand | clef | Workers AI REST from the Mac | 0.7 to 0.8 | 4 | 0.753 | 4 of 4 (100.0%) |
| heavyCommand | clef | Workers AI REST from the Mac | 0.8 to 0.9 | 42 | 0.863 | 42 of 42 (100.0%) |
| heavyCommand | clef | Workers AI REST from the Mac | 0.9 to 0.95 | 35 | 0.921 | 35 of 35 (100.0%) |
| heavyCommand | clef | Workers AI REST from the Mac | 0.95 to 1 | 58 | 0.970 | 58 of 58 (100.0%) |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.5 to 0.6 | 13 | 0.537 | 8 of 13 (61.5%) |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.6 to 0.7 | 14 | 0.655 | 8 of 14 (57.1%) |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.7 to 0.8 | 17 | 0.748 | 14 of 17 (82.4%) |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.8 to 0.9 | 31 | 0.859 | 30 of 31 (96.8%) |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.9 to 0.95 | 42 | 0.936 | 42 of 42 (100.0%) |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.95 to 1 | 25 | 0.956 | 25 of 25 (100.0%) |
| roomRouting | clef | later.dog relay from the Cloud home | 0.5 to 0.6 | 2 | 0.552 | 2 of 2 (100.0%) |
| roomRouting | clef | later.dog relay from the Cloud home | 0.7 to 0.8 | 2 | 0.751 | 2 of 2 (100.0%) |
| roomRouting | clef | later.dog relay from the Cloud home | 0.8 to 0.9 | 7 | 0.862 | 7 of 7 (100.0%) |
| roomRouting | clef | later.dog relay from the Cloud home | 0.9 to 0.95 | 10 | 0.928 | 10 of 10 (100.0%) |
| roomRouting | clef | later.dog relay from the Cloud home | 0.95 to 1 | 22 | 0.970 | 22 of 22 (100.0%) |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0 to 0.5 | 4 | 0.410 | 3 of 4 (75.0%) |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.6 to 0.7 | 1 | 0.631 | 1 of 1 (100.0%) |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.7 to 0.8 | 1 | 0.746 | 1 of 1 (100.0%) |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.8 to 0.9 | 11 | 0.870 | 10 of 11 (90.9%) |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.9 to 0.95 | 15 | 0.924 | 15 of 15 (100.0%) |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.95 to 1 | 11 | 0.965 | 11 of 11 (100.0%) |
| roomRouting | clef | Workers AI REST from the Mac | 0.5 to 0.6 | 2 | 0.552 | 2 of 2 (100.0%) |
| roomRouting | clef | Workers AI REST from the Mac | 0.7 to 0.8 | 2 | 0.751 | 2 of 2 (100.0%) |
| roomRouting | clef | Workers AI REST from the Mac | 0.8 to 0.9 | 7 | 0.862 | 7 of 7 (100.0%) |
| roomRouting | clef | Workers AI REST from the Mac | 0.9 to 0.95 | 10 | 0.928 | 10 of 10 (100.0%) |
| roomRouting | clef | Workers AI REST from the Mac | 0.95 to 1 | 22 | 0.970 | 22 of 22 (100.0%) |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0 to 0.5 | 4 | 0.410 | 3 of 4 (75.0%) |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.6 to 0.7 | 1 | 0.631 | 1 of 1 (100.0%) |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.7 to 0.8 | 1 | 0.746 | 1 of 1 (100.0%) |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.8 to 0.9 | 11 | 0.870 | 10 of 11 (90.9%) |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.9 to 0.95 | 15 | 0.924 | 15 of 15 (100.0%) |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.95 to 1 | 11 | 0.965 | 11 of 11 (100.0%) |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.5 to 0.6 | 1 | 0.565 | 0 of 1 (0.0%) |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.6 to 0.7 | 1 | 0.687 | 1 of 1 (100.0%) |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.8 to 0.9 | 5 | 0.853 | 5 of 5 (100.0%) |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.9 to 0.95 | 13 | 0.933 | 13 of 13 (100.0%) |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.95 to 1 | 50 | 0.965 | 50 of 50 (100.0%) |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.6 to 0.7 | 1 | 0.679 | 1 of 1 (100.0%) |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.7 to 0.8 | 4 | 0.782 | 3 of 4 (75.0%) |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.8 to 0.9 | 20 | 0.864 | 20 of 20 (100.0%) |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.9 to 0.95 | 30 | 0.930 | 30 of 30 (100.0%) |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.95 to 1 | 15 | 0.956 | 15 of 15 (100.0%) |

### Abstention

| Case | Model | Receipts from | Answer only at or above | Answered | Abstained | Right when answered | Wrong when answered | Right with the rule for the rest |
|---|---|---|---|---|---|---|---|---|
| dogRanking | clef | Workers AI REST from the Mac | 0.5 | 40 (100.0%) | 0.0% | 100.0% | 0 | 100.0% |
| dogRanking | clef | Workers AI REST from the Mac | 0.6 | 39 (97.5%) | 2.5% | 100.0% | 0 | 100.0% |
| dogRanking | clef | Workers AI REST from the Mac | 0.7 | 39 (97.5%) | 2.5% | 100.0% | 0 | 100.0% |
| dogRanking | clef | Workers AI REST from the Mac | 0.8 | 39 (97.5%) | 2.5% | 100.0% | 0 | 100.0% |
| dogRanking | clef | Workers AI REST from the Mac | 0.9 | 35 (87.5%) | 12.5% | 100.0% | 0 | 97.5% |
| dogRanking | clef | Workers AI REST from the Mac | 0.95 | 29 (72.5%) | 27.5% | 100.0% | 0 | 95.0% |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.5 | 38 (95.0%) | 5.0% | 100.0% | 0 | 97.5% |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.6 | 38 (95.0%) | 5.0% | 100.0% | 0 | 97.5% |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.7 | 37 (92.5%) | 7.5% | 100.0% | 0 | 97.5% |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.8 | 35 (87.5%) | 12.5% | 100.0% | 0 | 95.0% |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.9 | 29 (72.5%) | 27.5% | 100.0% | 0 | 92.5% |
| dogRanking | clef-flash | Workers AI REST from the Mac | 0.95 | 20 (50.0%) | 50.0% | 100.0% | 0 | 90.0% |
| heavyCommand | clef | Workers AI REST from the Mac | 0.5 | 142 (100.0%) | 0.0% | 100.0% | 0 | 100.0% |
| heavyCommand | clef | Workers AI REST from the Mac | 0.6 | 142 (100.0%) | 0.0% | 100.0% | 0 | 100.0% |
| heavyCommand | clef | Workers AI REST from the Mac | 0.7 | 139 (97.9%) | 2.1% | 100.0% | 0 | 100.0% |
| heavyCommand | clef | Workers AI REST from the Mac | 0.8 | 135 (95.1%) | 4.9% | 100.0% | 0 | 100.0% |
| heavyCommand | clef | Workers AI REST from the Mac | 0.9 | 93 (65.5%) | 34.5% | 100.0% | 0 | 88.0% |
| heavyCommand | clef | Workers AI REST from the Mac | 0.95 | 58 (40.8%) | 59.2% | 100.0% | 0 | 85.2% |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.5 | 142 (100.0%) | 0.0% | 89.4% | 15 | 89.4% |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.6 | 129 (90.8%) | 9.2% | 92.2% | 10 | 91.5% |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.7 | 115 (81.0%) | 19.0% | 96.5% | 4 | 91.5% |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.8 | 98 (69.0%) | 31.0% | 99.0% | 1 | 89.4% |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.9 | 67 (47.2%) | 52.8% | 100.0% | 0 | 85.9% |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 0.95 | 25 (17.6%) | 82.4% | 100.0% | 0 | 83.1% |
| roomRouting | clef | later.dog relay from the Cloud home | 0.5 | 43 (100.0%) | 0.0% | 100.0% | 0 | 100.0% |
| roomRouting | clef | later.dog relay from the Cloud home | 0.6 | 41 (95.3%) | 4.7% | 100.0% | 0 | 95.3% |
| roomRouting | clef | later.dog relay from the Cloud home | 0.7 | 41 (95.3%) | 4.7% | 100.0% | 0 | 95.3% |
| roomRouting | clef | later.dog relay from the Cloud home | 0.8 | 39 (90.7%) | 9.3% | 100.0% | 0 | 90.7% |
| roomRouting | clef | later.dog relay from the Cloud home | 0.9 | 32 (74.4%) | 25.6% | 100.0% | 0 | 81.4% |
| roomRouting | clef | later.dog relay from the Cloud home | 0.95 | 22 (51.2%) | 48.8% | 100.0% | 0 | 60.5% |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.5 | 39 (90.7%) | 9.3% | 97.4% | 1 | 88.4% |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.6 | 39 (90.7%) | 9.3% | 97.4% | 1 | 88.4% |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.7 | 38 (88.4%) | 11.6% | 97.4% | 1 | 86.0% |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.8 | 37 (86.0%) | 14.0% | 97.3% | 1 | 83.7% |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.9 | 26 (60.5%) | 39.5% | 100.0% | 0 | 72.1% |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 0.95 | 11 (25.6%) | 74.4% | 100.0% | 0 | 46.5% |
| roomRouting | clef | Workers AI REST from the Mac | 0.5 | 43 (100.0%) | 0.0% | 100.0% | 0 | 100.0% |
| roomRouting | clef | Workers AI REST from the Mac | 0.6 | 41 (95.3%) | 4.7% | 100.0% | 0 | 95.3% |
| roomRouting | clef | Workers AI REST from the Mac | 0.7 | 41 (95.3%) | 4.7% | 100.0% | 0 | 95.3% |
| roomRouting | clef | Workers AI REST from the Mac | 0.8 | 39 (90.7%) | 9.3% | 100.0% | 0 | 90.7% |
| roomRouting | clef | Workers AI REST from the Mac | 0.9 | 32 (74.4%) | 25.6% | 100.0% | 0 | 81.4% |
| roomRouting | clef | Workers AI REST from the Mac | 0.95 | 22 (51.2%) | 48.8% | 100.0% | 0 | 60.5% |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.5 | 39 (90.7%) | 9.3% | 97.4% | 1 | 88.4% |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.6 | 39 (90.7%) | 9.3% | 97.4% | 1 | 88.4% |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.7 | 38 (88.4%) | 11.6% | 97.4% | 1 | 86.0% |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.8 | 37 (86.0%) | 14.0% | 97.3% | 1 | 83.7% |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.9 | 26 (60.5%) | 39.5% | 100.0% | 0 | 72.1% |
| roomRouting | clef-flash | Workers AI REST from the Mac | 0.95 | 11 (25.6%) | 74.4% | 100.0% | 0 | 46.5% |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.5 | 70 (100.0%) | 0.0% | 98.6% | 1 | 98.6% |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.6 | 69 (98.6%) | 1.4% | 100.0% | 0 | 100.0% |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.7 | 68 (97.1%) | 2.9% | 100.0% | 0 | 98.6% |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.8 | 68 (97.1%) | 2.9% | 100.0% | 0 | 98.6% |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.9 | 63 (90.0%) | 10.0% | 100.0% | 0 | 95.7% |
| waitingOnOwner | clef | Workers AI REST from the Mac | 0.95 | 50 (71.4%) | 28.6% | 100.0% | 0 | 91.4% |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.5 | 70 (100.0%) | 0.0% | 98.6% | 1 | 98.6% |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.6 | 70 (100.0%) | 0.0% | 98.6% | 1 | 98.6% |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.7 | 69 (98.6%) | 1.4% | 98.6% | 1 | 97.1% |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.8 | 65 (92.9%) | 7.1% | 100.0% | 0 | 95.7% |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.9 | 45 (64.3%) | 35.7% | 100.0% | 0 | 90.0% |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 0.95 | 15 (21.4%) | 78.6% | 100.0% | 0 | 82.9% |

### Answers that pass the product's checks

| Case | Model | Receipts from | Asked | No answer | Valid | Invalid |
|---|---|---|---|---|---|---|
| dogRanking | clef | Workers AI REST from the Mac | 40 | 0 | 40 of 40 (100.0%) | 0 |
| dogRanking | clef-flash | Workers AI REST from the Mac | 40 | 0 | 40 of 40 (100.0%) | 0 |
| heavyCommand | clef | Workers AI REST from the Mac | 142 | 0 | 142 of 142 (100.0%) | 0 |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 142 | 0 | 142 of 142 (100.0%) | 0 |
| roomRouting | clef | later.dog relay from the Cloud home | 53 | 0 | 53 of 53 (100.0%) | 0 |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 53 | 0 | 53 of 53 (100.0%) | 0 |
| roomRouting | clef | Workers AI REST from the Mac | 53 | 0 | 53 of 53 (100.0%) | 0 |
| roomRouting | clef-flash | Workers AI REST from the Mac | 53 | 0 | 53 of 53 (100.0%) | 0 |
| waitingOnOwner | clef | Workers AI REST from the Mac | 70 | 0 | 70 of 70 (100.0%) | 0 |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 70 | 0 | 70 of 70 (100.0%) | 0 |

### Latency

| Model | Receipts from | Answered | p50 ms | p95 ms | Worst ms | Within 100 ms | Within 250 ms | Within 500 ms | Within 1000 ms | Within 1500 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| clef | Workers AI REST from the Mac | 305 | 413 | 876 | 3297 | 0.0% | 2.0% | 70.2% | 97.4% | 99.0% |
| clef-flash | Workers AI REST from the Mac | 305 | 274 | 478 | 1420 | 0.0% | 32.8% | 95.4% | 99.3% | 100.0% |
| clairic | Workers AI REST from the Mac | 78 | 319 | 442 | 507 | 0.0% | 14.1% | 98.7% | 100.0% | 100.0% |
| clef | later.dog relay from the Cloud home | 53 | 394 | 1155 | 3308 | 0.0% | 0.0% | 73.6% | 92.5% | 98.1% |
| clef-flash | later.dog relay from the Cloud home | 53 | 274 | 687 | 1269 | 0.0% | 45.3% | 90.6% | 98.1% | 100.0% |

| Case | Model | Receipts from | Answered | p50 ms | p95 ms | Worst ms | Over 1500 ms |
|---|---|---|---|---|---|---|---|
| dogRanking | clef | Workers AI REST from the Mac | 40 | 433 | 647 | 842 | 0 |
| dogRanking | clef-flash | Workers AI REST from the Mac | 40 | 286 | 608 | 901 | 0 |
| heavyCommand | clef | Workers AI REST from the Mac | 142 | 408 | 879 | 3297 | 2 |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 142 | 271 | 410 | 759 | 0 |
| roomRouting | clef | later.dog relay from the Cloud home | 53 | 394 | 1155 | 3308 | 1 |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 53 | 274 | 687 | 1269 | 0 |
| roomRouting | clef | Workers AI REST from the Mac | 53 | 415 | 1016 | 1963 | 1 |
| roomRouting | clef-flash | Workers AI REST from the Mac | 53 | 263 | 474 | 628 | 0 |
| waitingOnOwner | clef | Workers AI REST from the Mac | 70 | 397 | 889 | 949 | 0 |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 70 | 317 | 479 | 1420 | 0 |

### Cost

| Case | Model | Receipts from | Mean input tokens | $ per call | $ per 1,000 calls |
|---|---|---|---|---|---|
| dogRanking | clef | Workers AI REST from the Mac | 423 | 0.0001015 | 0.1015 |
| dogRanking | clef-flash | Workers AI REST from the Mac | 423 | 0.0000161 | 0.0161 |
| heavyCommand | clef | Workers AI REST from the Mac | 216 | 0.0000518 | 0.0518 |
| heavyCommand | clef-flash | Workers AI REST from the Mac | 216 | 0.0000082 | 0.0082 |
| roomRouting | clef | later.dog relay from the Cloud home | 439 | 0.0001055 | 0.1055 |
| roomRouting | clef-flash | later.dog relay from the Cloud home | 439 | 0.0000167 | 0.0167 |
| roomRouting | clef | Workers AI REST from the Mac | 439 | 0.0001055 | 0.1055 |
| roomRouting | clef-flash | Workers AI REST from the Mac | 439 | 0.0000167 | 0.0167 |
| waitingOnOwner | clef | Workers AI REST from the Mac | 221 | 0.0000530 | 0.0530 |
| waitingOnOwner | clef-flash | Workers AI REST from the Mac | 221 | 0.0000084 | 0.0084 |

### Extraction

| Calls | No answer | Valid | Invalid | p50 ms | p95 ms | Worst ms | Mean input tokens | $ per call | $ per 1,000 calls |
|---|---|---|---|---|---|---|---|---|---|
| 78 | 0 | 78 of 78 (100.0%) | 0 | 319 | 442 | 507 | 356 | 0.0000356 | 0.0356 |

| Reset time, 42 messages, as the wall-clock time of the reset | Result |
|---|---|
| Model | 39 right (9 of them correctly empty), 3 wrong value, 0 value where none exists, 0 missed |
| Rule | 26 right (9 of them correctly empty), 0 wrong value, 0 value where none exists, 16 missed |
| Rule, then the model where the rule finds nothing | 42 right (9 of them correctly empty), 0 wrong value, 0 value where none exists, 0 missed |
| Model, empty when its chance of nothing is above 0.05 | 41 right (9 of them correctly empty), 1 wrong value, 0 value where none exists, 0 missed |
| Model, empty when its chance of nothing is above 0.1 | 40 right (9 of them correctly empty), 2 wrong value, 0 value where none exists, 0 missed |
| Model, empty when its chance of nothing is above 0.3 | 40 right (9 of them correctly empty), 2 wrong value, 0 value where none exists, 0 missed |
| Model, empty when its chance of nothing is above 0.5 | 39 right (9 of them correctly empty), 3 wrong value, 0 value where none exists, 0 missed |
| Model, empty when its chance of nothing is above 0.7 | 39 right (9 of them correctly empty), 3 wrong value, 0 value where none exists, 0 missed |
| Model, empty when its chance of nothing is above 0.9 | 39 right (9 of them correctly empty), 3 wrong value, 0 value where none exists, 0 missed |

| Reset field, exact match | Result |
|---|---|
| reset_time | 41 right (13 of them correctly empty), 1 wrong value, 0 value where none exists, 0 missed |
| reset_date | 20 right (14 of them correctly empty), 0 wrong value, 22 value where none exists, 0 missed |
| time_zone | 30 right (17 of them correctly empty), 0 wrong value, 10 value where none exists, 2 missed |
| wait | 41 right (38 of them correctly empty), 1 wrong value, 0 value where none exists, 0 missed |

Waits within 1% of the labelled seconds: 4 of 4.

Reset misses: r007 got 2026-11-11T23:45 want 2026-11-10T23:45 (1.00); r032 got 2026-11-10T19:45 want 2026-11-10T14:55 (0.02); r033 got 2026-11-11T15:00 want 2026-11-10T15:00 (1.00)

| Short text, 24 messages | Model | Rule |
|---|---|---|
| Amount, within half a cent | 24 right (9 of them correctly empty), 0 wrong value, 0 value where none exists, 0 missed | 18 right (9 of them correctly empty), 2 wrong value, 0 value where none exists, 4 missed |
| Date, exact | 23 right (7 of them correctly empty), 0 wrong value, 0 value where none exists, 1 missed | 21 right (7 of them correctly empty), 0 wrong value, 0 value where none exists, 3 missed |

Short text misses: s005 date missed

Computed values: 10 of 12 right, of which numbers within half a cent 6 of 7. Estimates: 6 of 7 had the true value between the 10th and 90th percentile, 3 of 7 landed within one step.

Computed misses: c008 got 215; c010 got 16:20:00

Evidence: 23 of 23 text answers came with a span that reads back as the value (23 had a span), and 13 of those were the right value; 0 of 111 typed answers carried a span. 11 of 15 amounts returned are written as digits in the text.

Mean reported confidence: 0.945 when right, 0.701 when wrong.

### Rule timing

| Case | Rule calls timed | p50 µs | p95 µs | Worst µs | Slowest item |
|---|---|---|---|---|---|
| roomRouting | 10600 | 3.8 | 5.7 | 341.0 | rh01 |
| heavyCommand | 28400 | 1.3 | 4.2 | 354.0 | l057 |
| waitingOnOwner | 14000 | 0.2 | 0.3 | 35.2 | w021 |
| dogRanking | 8000 | 21.6 | 36.4 | 300.0 | k024 |

### Failure probes replayed

| Replayed from | What the provider did | Calls | What the decider reported | Rule answered instead | Rule right, where labelled |
|---|---|---|---|---|---|
| later.dog relay from the Cloud home | HTTP 200 | 70 | answered | 0 of 70 | n/a |
| later.dog relay from the Cloud home | HTTP 429 | 36 | rate_limited | 36 of 36 | 8 of 29 |
| 100 ms deadline, Workers AI REST from the Mac | no answer by the deadline | 10 | timeout | 10 of 10 | 10 of 10 |
| invalid requests, Workers AI REST from the Mac | HTTP 400 | 1 | http_error | 1 of 1 | n/a |
| invalid requests, Workers AI REST from the Mac | HTTP 422 | 1 | http_error | 1 of 1 | n/a |
| made-up invalid answers | HTTP 200 | 5 | malformed | 5 of 5 | 4 of 5 |
