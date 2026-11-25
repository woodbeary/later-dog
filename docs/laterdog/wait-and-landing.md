# The wait and the landing

Refinement packages E1 (the wait) and E2 (the landing), designed together because they are one
experience. This is a design for the owner to accept or refuse by looking. It is a prototype, not
production wiring: builders work from it once the look is approved.

- Prototype: `scripts/testing/wait-and-landing-preview.tsx` (a preview page the app never loads),
  its model `scripts/testing/wait-and-landing-model.ts` (every state, its words and the pacing
  rules) and that model's test.
- Pictures and numbers: `docs/verification/assets/wait-and-landing/`, made by
  `scripts/testing/wait-and-landing-shots.ts` (the prototype) and
  `scripts/testing/wait-and-landing-before.ts` (today's app on a fake-engine fixture). Every frame
  behind the contact sheets stays in `.laterdog-evidence/wait-and-landing/`, which git ignores. How
  to run them is at the end.

A reply arrives finished on both apps, so from the moment a person sends until the reply lands,
what they see is the dog working. That wait is the main experience of later.dog now.

## What the person needs while they wait

Six things, in this order, and nothing else on screen:

1. **That it is alive.** The dog's face, moving. It is the one moving thing.
2. **Roughly what it is doing.** One plain phrase that changes rarely enough to be read.
3. **Whether to worry.** How long, but only once it has been a minute.
4. **Whether it needs them.** Said at once, in the waiting colour, pointing at the card that asks.
5. **Whether it waits on something else.** A limit, its computer, the home waking: what and until when.
6. **More, when they ask.** The work panel on the Mac, the work sheet on the phone.

## What is wrong today, measured

Same turn on today's app (a fake-engine fixture; the numbers are under `today` in `checks.json`):
four earlier exchanges, then "Can you get the order form working again?"; the dog reads two files,
changes one, runs a command for over a minute, then replies.

- **Redundant.** During the turn the Mac described it in five places at once: the work line, a green
  dot on the header pill, a green dot on the sidebar row, the sidebar row's line, and (for the first
  quarter second) a sending bar under the person's bubble. In a room it is more: `TurnPresence`,
  `NativeWork`, `WorkStatusLine` in the header and, with tool calls shown, tool chips.
- **Inconsistent.** At the same moment the sidebar said "Reading it through" and the chat said
  "Trying it out": the sidebar reads the home's `step`, the chat reads the live run.
- **Twitchy.** The work line mounts after the send (0 to 32 px) and pushed the person's message up
  39 px in a chat that follows the bottom. Its phrase changes at every step, with a different synonym
  per step id and no hold. At landing every one of the 14 rows above moved 68 px, because the view
  scrolls to the end, and a fold line appeared above the reply.
- **Sluggish.** The wait carries no sense of time until the phrase happens to change.

Today's frames and the proposed ones are side by side in `before-after.png`.

## The surface: the turn slot

One surface per turn, on both apps, everywhere a turn runs: a dog's chat, a task's chat and a room.

- **Where.** Directly under the newest row, in the dog's column (left). In a room, it is the speaking
  dog's (`busyBotId`); with several dogs working and none speaking, the first named.
- **When.** The space is reserved the moment a turn starts (the person sends, or a pickup, routine,
  wake or teammate starts it). The line appears 300 ms later, so a reply faster than that lands
  without a flash. It stays until the turn's outcome lands.
- **Height.** Fixed: 32 px on the Mac, a 44 pt row on the phone (with the usual 12 pt above). The
  content changes inside it; nothing above or below moves when the state changes. One line, never
  wrapping: the phrase truncates with an ellipsis and the time and side jobs keep their place. At large
  text sizes the height follows the text size, never the state.
- **What it shows.** `[face] phrase · time · side jobs`
  - First: the dog's face and one phrase.
  - Second: the time, from one minute on ("for 6 min"), then side jobs ("2 side jobs", which open the
    side jobs page on their own).
  - Never: tool names, file paths, commands, seconds, counts like "2 of 5", spinners, dots, model or
    account names, a row of puppy faces, reasoning text.
- **The face.** The dog's own avatar (`DogAvatar`, its breed and colour), 24 px on the Mac and 28 pt
  on the phone. Its mood follows the state (table below). The words do not shimmer: the face is the
  only moving thing in the slot, and under Reduce Motion nothing moves at all.
- **On demand.** Clicking or tapping the line opens the work panel (Mac) or work sheet (phone) for
  this turn: steps with their plain subjects, puppies, helpers, side jobs, the to-do list, the live
  reasoning summary, how long the whole turn has run, and which account and model it runs on. A line
  that waits for the person scrolls the card into view and focuses its first button; a helper's ask
  opens that dog's chat.
- **Out of view.** When the person has scrolled up, the existing jump control speaks for the slot
  only when the dog needs them: "Waiting for your OK ↓" in the waiting colour. Otherwise it stays
  "Jump to latest", or "1 new reply" once the reply has landed.

Pictures: `states-1-light.png`, `states-2-light.png`, `states-1-dark.png`, `states-2-dark.png` (every
state below, Mac column and phone mock). The shot script measures every slot in the grid, 48 on each
platform in each theme (the 49th row, a reply with no steps, draws the reply itself): all 32 px on
the Mac and all 44 pt on the phone.

## How often it may change

- **One phrase per kind of step for the whole turn.** Reading stays "Reading it through" across
  twenty reads; the synonym is chosen once per turn, not per step.
- **Settle 1 s, hold 2.5 s.** A new phrase shows only once it has been current for 1 s and the shown
  phrase has been up for 2.5 s. Bursts collapse; short thinking gaps between steps never show.
- **Waiting for the person skips both, both ways.** It shows at once and leaves at once when answered.
- **The time changes once a minute, in place,** and does not count as a change.
- **A long step says what it is.** After a minute on one step, the step's plain subject (when the
  home sent one) replaces the generic phrase: "Running the order form tests · for 6 min".
- On the busy turn this gives four visible changes in 77 seconds ("Sorting it out", "Trying it out",
  "Running the order form tests · for 1 min", "Writing back"), never sooner than 2.5 s apart. The
  model's test pins it.

## Every state a turn can be in

From the code, send to finished. Each row is drawn in the grid; the full list with causes and
sources is `turnStates()` in the model. Tones: plain (secondary ink), asks (waiting colour), quiet
(secondary ink, still face).

### Delivery

| State | Caused by | The slot says | Face |
| --- | --- | --- | --- |
| Sending | The send is still on its way after 2 s (`PROGRESS_AFTER_MS`, `src/lib/outbox.ts`) | Sending | idle |
| Not sent yet | The outbox holds it: offline, timeout, 502/503/504, 408, 429 (`sendOutcome`) | Not sent yet | idle |
| Waking a sleeping home | 503 with `x-laterdog-home: waking` or `asleep` (`shared/home-wake.ts`, `src/lib/api.ts`) | Waking up your home | waking |
| Home busy | 503 with `busy` | Waiting for your home | idle |
| Home slow to wake | Waking past 2 min (`WAKE_TOO_LONG`); the outbox keeps holding | Still waking your home | sleeping |
| Queued behind this turn | Sent with queue while a turn runs (`pendingQueued`) | the running turn's line; the message waits in the composer's queued strip | — |
| Read your message | A message steered into the turn was read (`readAt`) | Read your message (one hold) | listening |

### Working

| State | Caused by | The slot says | Face |
| --- | --- | --- | --- |
| Thinking | Live run with no current step, or reasoning (`liveStep`) | Thinking it over · Working it out · Sorting it out | thinking |
| Reading | read, view, open | Doing some reading · Reading it through · Going through it | searching |
| Searching files | search, find, list | Looking around · Digging through it | searching |
| Looking something up | web search, fetch, open a site | Looking it up · Reading up on it | searching |
| Changing things | edit, patch | Making changes · Tidying it up | working |
| Writing something new | write a file | Writing it up · Putting it into words | writing |
| Running a command | shell | Trying it out · Checking the result | working |
| Using the screen | screenshot, click, type | Looking at the screen · Taking a look · Clicking around | searching |
| Asking another dog | coordinate with dogs | Checking in with the others | listening |
| One long step | One step past a minute with a plain `subject` | Running the order form tests · for 6 min | working |
| Same kind for minutes | Many short steps of one kind | Reading it through · for 3 min | searching |
| Puppies helping | The current step hands work to native helpers (`nativePuppies`) | Getting help from 3 puppies | listening |
| Side jobs alongside | Background helpers or commands (`sideJobCount`) | Making changes · 2 side jobs | working |
| Waiting on side jobs | The dog waits; only background work runs (`heldBySideJobs`) | Waiting on 2 side jobs | listening |
| Writing the reply | Current activity is the reply (`message`) | Writing back | writing |
| Tidying its memory | The engine summarizes earlier context (`compaction`) | Tidying up its notes | thinking |
| Other dogs working | `work.kind` waiting-on-dog (`handoffWait`) | Pebble and Thistle are working · for 4 min | listening |
| A command still running | The turn ended; a job on its computer lives (`work.computerJobs`) | Running a command · for 12 min | working |
| A command past two hours | `work.computerBackground` (past 2 h, or unreadable) | Still running a command · for 2 hr 5 min | idle |
| Picking up | A pickup turn: restart, stall watch, a finished command (`tool.pickup`) | Picking up where it left off | waking |
| Moving to another account | Limit mid-turn, carried on elsewhere (`tool.carry`) | Moving to Personal (one hold) | waking |

### Waiting on you

All in the waiting colour, all at once, face alert (one hop, then still).

| State | Caused by | The slot says |
| --- | --- | --- |
| Approval | Open approval or device approval card; `activity` waiting-on-you | Waiting for your OK |
| Question | Open question, docked above the composer (`openQuestion`) | Waiting for your answer |
| Secure form | Secure form or secret request card | Waiting for your details |
| Sign in to an app | Connector card | Waiting for you to sign in |
| Take over the screen | Take-over card, or the computer's help reason (`NeedsYouRow`) | Your turn at the screen |
| A helper dog asks | waiting-on-dog with an `ask` | Pebble needs your answer (opens Pebble's chat) |
| Account off or signed out | needs-you with an account `hold` | Sign in to Work to carry on · Turn on Work to carry on |

### Waiting on something else

| State | Caused by | The slot says | Face |
| --- | --- | --- | --- |
| Usage limit | waiting-for-usage with `until` | Resting until 3:40 | sleeping |
| Usage limit, no time | waiting-for-usage without `until` | Resting until its limit resets | sleeping |
| Computer in use | waiting-for-computer (`turn.wait_started`) | Waiting for its computer | idle |
| Reconnecting | retrying (`turn.retrying`) | Trying again | thinking |

### Ends

The slot always ends as a one-line record or hands its place to the outcome.

| State | Caused by | What stays |
| --- | --- | --- |
| Finished | Reply arrived, run ended | Fold line "Made 1 change and tried 1 thing ›" with the reply below |
| Finished, no steps | Reply arrived, run had no steps | The reply takes the slot's place |
| Stopped by you | The person pressed Stop | "Stopped by you · Made 1 change ›" |
| Stopped early | The engine closed (`stopped`, detail closed) | "Stopped before it finished" |
| Stopped after a stall | The stall watch (`stopped`, detail stalled) | "Stopped: no progress for too long" |
| Failed | An error ended the turn | Fold line, then the error row with its own action (`FailedTurnRow`, `LimitRow`) |
| Side jobs after the reply | Background work still runs | "2 side jobs still going ›" under the reply until they end |

### Rooms

| State | Caused by | The slot says |
| --- | --- | --- |
| One dog working | `group.busyBotId` | that dog's face and line, as in a dog's chat |
| Several dogs working | `group.work` running with dogs | Pebble and Thistle are working |
| A dog in the room asks | an approval card from one member | Waiting for your OK, with that dog's face |

## One vocabulary for both apps

Every line above is the same text on both apps, from one table in `shared/` copied byte for byte to
the phone like `shared/step-words.ts`. The rules the model's test enforces:

- Fixed words fit one line at 393 pt: 30 characters at most. Names and subjects truncate.
- Plain present tense a person can hear read aloud: no tool names, paths, commands or seconds.
- Each line has a whole spoken sentence that names the dog: "Scout has been running the order form
  tests for 6 minutes." "Scout's Work account is resting until 3:40. Scout carries on then." "Your
  message to Scout isn't sent yet. later.dog keeps trying."
- Times are `for 6 min`, `for 1 hr 5 min`, a clock time for limits; never seconds.
- Dog words where they belong: dogs, puppies, resting; nowhere forced.

## Motion

Only opacity and transform, with the tokens in `docs/laterdog/motion.md`.

| Moment | Motion |
| --- | --- |
| Line appears | Face grows from 82% and fades in over `--duration-slower` on `--ease-enter`; words rise 4 px and fade in over `--duration-slow` |
| Phrase changes in place | Old words fade out over `--duration-fast` on `--ease-exit`; then new words rise 4 px and fade in over `--duration-slow` on `--ease-enter`. The two never overlap |
| Mood changes | The face's own pose transition (ears and eyes, `--duration-slower`) |
| Waiting for the person | One alert hop, then still |
| The time | Changes in place, no animation |
| Landing | See below; one `--duration-slower` beat in all |

In-place swaps leave over `--duration-fast`, faster than they arrive, so two phrases are never on
screen together; the 300 ms exit in motion.md stays for surfaces that leave the screen. The thinking
shimmer (`.thinking-shimmer`, a background-position loop) is dropped from the line.

Reduce Motion: the face holds its mood's pose with no loop and no hop; words and the fold line fade
in over `--duration-normal`; what leaves goes at once. `landing-mac-reduced-sheet.png` shows it.

## The landing

`landing-mac-sheet.png`, `landing-phone-sheet.png`, `landing-mac.gif`, `landing-phone.gif`.

- **In place.** When the run had steps, the slot's row becomes the fold line ("Made 1 change and
  tried 1 thing ›") and the reply arrives below it. Without steps, the reply takes the slot's place.
- **Timing.** 0 to 100 ms: the working words and the face leave. 100 to 300 ms: the fold line fades
  in. 0 to 200 ms: the reply arrives like any message, sliding in from its side
  (`[data-arriving]`, `--duration-slow`, `--ease-enter`). The special `.turn-answer` grow goes.
- **Room for the answer.** When a turn starts and the person is following the bottom, the chat makes
  room once: 40% of the visible transcript, below the slot. This is the only movement, and it happens
  when the person acts. Replies land into the room and it shrinks by what lands, so the content height
  stays the same and nothing above moves. A reply taller than the room continues below the fold.
- **Landing never scrolls.** The reply's first line appears where the person was already looking; a
  long reply is read from its top, and the jump control appears for the rest.
- **Reading older messages.** Nothing in view moves; the jump control reads "1 new reply".
- **Several close together.** Arrivals within one `--duration-slower` land as one batch, each one
  `--duration-instant` after the previous, at most four staggered.
- **A reply in the middle of a turn** lands the same way; the slot comes back below it if work goes
  on for 2 s (today's `STILL_WORKING_MS`).
- **Failed or stopped turns** land the same way: the fold line says how it ended and the outcome row
  arrives below.

Measured in the prototype (`checks.json`, rows that were already on screen, every frame of the
landing and after it):

| Case | Mac rows · max move · scroll · content growth | Phone rows · max move · scroll · content growth |
| --- | --- | --- |
| Reply with steps | 9 · 0 px · 0 px · 0 px | 9 · 0 · 0 · 0 |
| Reply without steps | 8 · 0 px · 0 px · 0 px | 8 · 0 · 0 · 0 |
| Long reply | 9 · 0 px · 0 px · grows 221 px below | 9 · 0 · 0 · grows 450 pt below |
| Reading older messages | 15 · 0 px · 0 px · 0 px | 15 · 0 · 0 · 0 |
| Three replies from two dogs | 8 · 0 px · 0 px · 0 px | 8 · 0 · 0 · 0 |
| Separate bubbles | 9 · 0 px · 0 px · 0 px | 9 · 0 · 0 · grows 14 pt below |
| With Reduce Motion | 9 · 0 px · 0 px · 0 px | 9 · 0 · 0 · 0 |

Today's app on the same turn: 14 rows, each moved 68 px at landing; the person's message moved 39 px
when the work line mounted.

## One bubble or separate bubbles

`bubbles-mac.png` and `bubbles-phone.png` show the same finished reply both ways: a short result, a
paragraph of what changed, and a question back.

Recommendation: **one bubble**. The reply is one finished thing; kept whole it reads top to bottom,
copies in one go and lands as one arrival. Separate bubbles turn one answer into three arrivals and
three gaps, and splitting has to be guessed: on paragraphs it cuts lists and code apart, and the
question it means to lift out is better served by the question card the dog can already raise. A dog
that truly has two things to say can already send two messages. Separate bubbles do make a closing
question easier to spot; that is the case for choosing them.

## Screen readers

- The slot is a button whose accessible name is the spoken sentence; the face is hidden from them.
- Pushed, politely, through `TranscriptAnnouncer` on the Mac and `announceForAccessibility` on the
  phone: when the dog needs the person (at once); when a wait on something else has lasted 10 s (a
  limit, its computer, not sent, the home slow to wake); when the reply lands ("Scout replied: …", as
  today); when the turn fails or stops by itself. Never a step.
- At most one push per 10 s, apart from a request for the person and the reply.
- Today the phone announces every step change; that goes.

## What happens to today's surfaces

The builders' table. Mac files unless noted.

| Surface | Today | Fate |
| --- | --- | --- |
| `ChatWorkLine` in `src/components/TurnPresence.tsx`, `src/lib/work-line.ts`, `.work-line` in `src/chat-calm.css` | The dog chat's work line; mounts and unmounts, phrase per step | **Becomes the turn slot.** Fixed height, never unmounts mid-turn, pacing, face moods, new words, no shimmer. Move it to its own file |
| `TurnPresence` (rooms, `src/components/GroupView.tsx`) | 36 px mascot row, 4.5 s rotating phrases, elapsed, puppies, 300 ms exit, swaps to `NativeWork` | **Merged** into the slot. Remove the rotation (`ROTATE_MS`, `rowPhrase`, `src/lib/thinking-row.ts`), `useArmedAfter` and `useActivityPresence` (`src/lib/activity-presence.ts`), `.turn-mascot-in/out` and `.turn-answer` in `src/styles.css` |
| `NativeWork` live row (`src/components/NativeWork.tsx`) | Swaps in for `TurnPresence` when armed; different size | **Merged** into the slot |
| `NativeWork` receipts after room messages | "View work ›" and puppy faces under each room reply | **Merged** into the fold line, as in dog chats |
| `NativeWorkDetail` (same file) | Modal with actors, activities and Stop helper | **Merged** into the work panel: a page per puppy, with Stop helper there. Rooms open the work panel too |
| `NativeWorkFallbacks`, `NativeHistoryNotice` | Receipts with no reply; "Some earlier work is no longer available" | **Kept**: fallbacks as fold lines; the notice moves into the work panel |
| `WorkPanel` (`src/components/WorkPanel.tsx`, `src/work-panel.css`, `src/lib/work-panel*.ts`, `WorkSteps`, `WorkHelpers`, `WorkTodo`, `SideJobs`, `StepPage`, `SideJobPage`) | On-demand detail | **Kept**, the one place for detail. Gains the live reasoning summary, puppy pages, the turn's total time in its title, the account and model. Not a duplicate: nothing else lists steps |
| `ActivityPeek` (`src/components/ActivityPeek.tsx`) | Popover from `TurnPresence`: reasoning, steps, updates | **Merged** into the work panel |
| `Puppies` (`src/components/Puppies.tsx`) | Puppy faces in the presence row | **Removed** from the line; "Getting help from 3 puppies" and the panel replace it |
| `StatusActivityRow` progress kind (`notice:` with `statusLine: "live"`, "Still on it: …") | A transcript row during long quiet stretches | **Merged** into the slot's long-step line; reuse the server's gerund table (`server/laterdog/status-lines.ts`) for subjects |
| `StatusActivityRow` carry (`CarriedAccount`) | Transcript row "→ Continuing on Personal" mid-turn | **Merged**: "Moving to Personal" in the slot for one hold; the record is How it ran. `RunningOnLine` keeps the standing route |
| `StatusActivityRow` recovery and notice | `recovery:` and `notice:` lines | **Kept**: records of what happened while the person was away; the slot says "Picking up where it left off" live |
| `StatusActivityRow` resume (`ContinueWork`) | "Continue?" with a button | **Kept**: an action, not a status |
| `ActivityChip` (in `ChatView.tsx`) | "Messaged ◯ Pebble", thread notes, cloud task cards | **Kept**: records that open the exchange; they land like any row |
| `TurnReceiptLine` (`src/components/TurnReceiptLine.tsx`) | "Ran on Work · model", on demand | **Kept**: the only place for account and model, now also the record of a move |
| `WorkingDots` (`src/components/WorkingIndicator.tsx`) | Three pulsing dots in running tool chips | **Removed** from the default view; stays only inside the tool-call developer view |
| `WorkingTimer` (same file) | A seconds timer in `NativeWork`, `NativeWorkDetail`, `WorkStatusLine`, `ActivityPeek` | **Removed**: minutes only, in the slot or the panel title |
| `HeaderStatusDot` (in `ChatView.tsx`) with `StatusDot` | Green working or amber waiting dot on the header pill | **Removed**: the slot says it in the same view |
| `StatusDot` (`src/components/StatusDot.tsx`) in the sidebar | Unread dot on room rows | **Kept** |
| Sidebar `RowDot` (`src/components/Sidebar.tsx`, `dot` in `src/lib/dog-row.ts`) | Green working, amber waiting, blue unread | **Working dot removed**: the row's face moves and its line says what. Waiting and unread **kept**: they ask for attention |
| Sidebar row line (`rowLine`, `src/lib/dog-row.ts`) | Its own words from the home's `step` | **Kept**, with the slot's words and pacing from the same source (the run first), so the two never disagree. Needs-you keeps its detail ("Waiting for you: run the tests") because the card is not on screen |
| `WorkStatusLine` (`src/components/WorkStatusLine.tsx`, room header) | "Pebble and Thistle are working", computer jobs with a seconds timer | **Removed**: the room's slot carries it; the sidebar row carries it for rooms not in view |
| `ToolActivity`, `ActivityRun` (`src/components/ToolActivity.tsx`, `ActivityRun.tsx`) | Tool chips in rooms, only with `features.showToolCalls` | **Kept behind the flag** as a developer view; with the flag off nothing changes |
| `SendingTrack` (`src/components/SendingTrack.tsx`) | Sending bar after 2 s and "Not sent yet" under the bubble | **Merged** into the slot: "Sending", "Not sent yet", "Waking up your home" |
| `ReadReceipt` (same file) | "Sent" and "Read" under a steered bubble | **Merged**: "Read your message" in the slot for one hold; the line under the bubble goes |
| `FoldLine` (`src/components/FoldLine.tsx`) | Receipt above the reply | **Kept**: it is what the slot becomes at landing; rooms get it too |
| `SideJobsStillGoing` (same file) | Quiet line under the reply | **Kept** as the slot's after-the-reply form |
| `FailedTurnRow`, `ErrorRow`, `LimitRow` | Outcomes with actions | **Kept**: they land like a reply |
| `TranscriptAnnouncer` (`src/components/TranscriptAnnouncer.tsx`, `src/lib/transcript-announcer.ts`) | Announces approvals, questions, replies | **Kept**, with the rules above |
| Approval, question, secure form, connector, take-over, device cards; `NeedsYouRow`; `MacScreenTile` | Actions | **Kept**: the slot names the state; the card holds the action |
| `RunningOnLine` (`src/components/RunningOnLine.tsx`) | The chat's standing account route | **Kept**: a fact about the chat, not the turn |
| `ComposerQueuedMessages` | Queued messages above the composer | **Kept**: the person's own outgoing messages, with Send now |
| `useWorkingDots` (`src/lib/working-dots.ts`) | 2 s before working shows again after a mid-turn reply | **Kept** as the rule for the slot coming back |
| `src/lib/live-activity.ts` | Activity kind from transcript rows | **Kept** as the fallback for homes and engines without native runs |
| `workLine`, `sidebarWorkLine`, `roomRowLine` (`src/lib/work-state.ts`) | Words for work states | **Replaced** by the shared table |

## The phone

From `woodbeary/later-dog-phone` at `1e2bc4f` (read only). It already has one working line under the
last message (`src/ui/ChatTail.tsx`, `WorkingRow.tsx`), a reserved slot (`TurnSlot.tsx`, 44 pt row),
pacing (`src/lib/turn-slot.ts`) and the work sheet. What changes:

- **One line.** Drop the two-line wrap (`PHRASE_LINES = 2`, `extrasOnOwnLine`): it changes the
  height. Truncate the phrase; keep the time.
- **Pacing.** `PHRASE_HOLD_MS` 800 becomes 2,500 with a 1,000 ms settle; key the phrase by kind and
  turn, not step id.
- **No glide.** The slot is reserved at once and consumed at landing; drop the `SLOT_GLIDE_MS` height
  animation.
- **Room for the answer** in the inverted list's footer: slot plus 40% of the visible list.
- **No shimmer** (`ThinkingLabel`) on the line: plain secondary text, the face moves.
- **Landing in place.** The line becomes the fold line instead of stepping aside; the answer keeps the
  phone's own arrival (rise 12 pt, 260 ms; fade only with Reduce Motion).
- **Announcements**: drop the per-step `announceForAccessibility`; follow the rules above.
- **Words**: the shared table, copied byte for byte.
- **Waking**: `src/lib/waking.ts` keeps its full-screen waking dog for a home that is not reachable at
  all; a send that waits on a waking home shows "Waking up your home" in the slot.

## What the builders need to know

- Everything the slot shows is on the wire today (`work`, `step`, native runs, the outbox's held and
  wake state, cards) except three: who stopped a run (for "Stopped by you"), a reliable `subject` on
  long steps across engines, and a live phase for the account move. Without them, fall back to
  "Stopped before it finished", the kind phrase and no move line.
- Use the live run first and the home's `step` only as a fallback, everywhere, so the sidebar and the
  chat cannot disagree.
- Pacing is one pure function (`pace` in the model) with tests to port to both apps.
- The room must be measured from the visible transcript at turn start and released at the next send.
- The fate table changes seventeen pieces; do them in one change per app so no surface is doubled
  in between.

## Not proven, and what I am unsure of

- **A mock is not the iPhone app.** The phone column is a faithful browser mock of its metrics; real
  device feel, Dynamic Type and VoiceOver are unmeasured.
- **Real engines' event rates.** The fake engine fires its steps at once; real bursts and long
  reasoning stretches may need the settle or hold tuned.
- **The room.** 40% is a judgment; how it feels across a long session of short questions is untested.
- **The face loop at 24 px for minutes** may tire the eye; slowing it after a minute is worth trying.
- **Subjects** read only as well as the home's `subject` field; engines that send none get the kind
  phrase.
- **Skins.** Shots use Daylight and Midnight; other skins were not shot.
- **The full merge gate was not run** for this prototype; lint, typecheck and the new tests were.

## The owner's choices

1. **One bubble or separate bubbles** for a reply with clearly separate parts. Recommendation: one
   bubble.
2. **Room for the answer.** 40% of the visible chat (recommended); none, where the view scrolls at
   landing as today; or a full page, where every send lifts the person's message to the top.
3. **The line's shimmer.** Drop it (recommended: the dog is the one moving thing) or keep it.
4. **The sidebar's green working dot.** Remove it (recommended: the moving face and the line say it)
   or keep it.
5. **Saying what a long step is** after a minute ("Running the order form tests"). Recommended yes.

## Running the shots

On a Mac, from a clean checkout with `pnpm install` done:

```sh
node --experimental-strip-types scripts/testing/wait-and-landing-before.ts
node --experimental-strip-types scripts/testing/wait-and-landing-shots.ts
pnpm exec vitest run scripts/testing/wait-and-landing-model.test.ts
```

Both use the headless browser the repository pins (`ensureUiBrowser`); set
`AGENT_BROWSER_EXECUTABLE_PATH` to use another Chrome or Chromium. The first starts an isolated
fake-engine home through `scripts/control-laterdog.ts` (`launchVerificationServer`, `new-bot`) and
mounts the real app; the second mounts only the preview and needs no server. `--only grid|landing|busy|bubbles|compare`
runs one part. The GIFs need `ffmpeg`; without it they are skipped.
