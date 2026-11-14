# Workspace release, November 13: what went live, how it was checked, how to undo it

This is the record for desktop 0.3.47 and everything released with it in the early hours of
November 13, 2026 (Pacific time). It says what a person now has, what was checked before
each step, and what is still unproven.

## What went live

| Piece | What | Identifier | Undo |
| --- | --- | --- | --- |
| Code | `main` holds the send outcomes, one work state per chat, exchange rows, turn results, the usage fixes, the usage and stall watches, the account choice, the leaner context and the rewritten dog instructions | `604dac3c3` | a new commit |
| Edge | Home Worker, Worker only, four commits on top of the November 11 deploy | version `56872e0d-b83b-429f-acdd-9b49922160c3` | `wrangler rollback 140cc777-2439-4e6a-ab82-91afe343ef92 --config wrangler.production.json` from `deploy/laterdog/home` |
| The owner's home | Server code as a pushed bundle (`scripts/dev-home.mjs push --session …`) | bundle `524b79dcadbc`, label `604dac3c3` | write the earlier pointer (hash `464b4ea3…`, label `629e4bb4b`) back to `dev-code/current.json` |
| Desktop | later.dog 0.3.47, signed, notarized and stapled | release `v0.3.47`, four files | none: apps that updated stay updated, so a fix is a newer version |
| Phone | Update on the `beta` channel from phone `main` `336a69d` | update group `673138be-0380-4869-88be-464b418b9233` | `eas update:republish --group 1e0d331b-cbd6-417b-ba0c-bcea084badcd` |

Other people's homes run the server inside the home image. They get the server changes with the
next image release; the desktop app and the phone update reach them now.

## What was checked before each step

- **Independent reviews.** Each stack was read by a reviewer who did not write it, with scripts
  that reproduce every finding: the activity chain, the usage fixes, the stall watch and the
  account choice (five rounds in all), the harness and instruction changes (two rounds), and
  the whole phone branch (three rounds). Every round found real defects; all were fixed and
  verified by the same reviewer. The last one, found three hours before release: a chat pinned
  to an account that was then switched off could move to its dog's model on another engine and
  lose the pin.
- **The whole suite.** Three full passes on the combined branch (about 14,800 tests, plus 320
  edge tests). The first found 21 failing files that focused runs had missed. The last, on
  `c7adc8957`, left only `server/laterdog/computer-runs.test.ts`,
  `server/agent-tool-policy.test.ts` and `server/cloud-lending.e2e.test.ts`, which fail on
  unchanged `main` too, and one write-heavy test in `server/cloud-lending.test.ts` that timed
  out on unchanged `main` in the same hour (the temporary folder was on a slow external
  drive). The reaction fix added after that pass was covered by 14 focused files.
- **A test home.** The combined server code was pushed to a test home three times. The
  home answered with the new work state, slept when left alone, and ran turns on the included
  model: a quick answer, a long task that opened with one line, a status question, a request
  to pay that was declined and handed back. A signed-out account was explained by the stall
  watch after three quiet minutes and not retried.
- **Real engines.** An isolated local server with the real coding engine ran 20 turns on two
  model sizes: opening line before work, an answer to a message sent mid-task, a truthful
  status list, a hand-off to a second dog with one message, a rarely used tool found on
  demand.
- **Found live, fixed before the public release.** On the included model a bare "thanks" came
  back as raw markup instead of a reaction. A reply that is nothing but one reaction is now
  applied as a tapback on every engine, and the included models are told to answer with one
  emoji. Seen working on the test home.
- **The edge.** Deployed to the test Worker first: bindings identical before and after, a
  repeated send delivered once, the held list answered for a session the home had confirmed.
  Production: 14 bindings byte-identical before and after, the owner's home answered through
  the new Worker with the same server process.
- **The owner's home.** No dog was working and the last save was under three minutes old
  before each push. After the switch: all 84 dogs with their last message, 69 groups, every
  chat idle, the held list answering.
- **The desktop build.** The release script was run as a dry run, the packaged server smoke
  test passed, Apple accepted the app and the disk image, and the built app was launched once
  in a sealed profile: the first-run screen rendered and its log held no error. The files
  published are the ones that were checked.
- **The phone.** 2,296 tests, `pnpm verify`, the native fingerprint equal to the installed
  build, three review rounds.

## Not proven

- The phone's message box was rewritten and has not been seen with an on-screen keyboard on a
  device. The update went out on the owner's word.
- The stall watch carrying work on after a real failure has not been observed on a real home;
  only its "stopped, sign in again" line has. After the release it was seen once with a real
  engine on an isolated server
  ([stall watch](stall-watch.md#seen-with-a-real-engine-november-13)).
- Account choice with several real accounts (the pick holding, a same-engine cover, the return)
  has only been seen on fixtures.
- Engines other than the first coding engine and the included model ran no live turn.
- The coding engine offers no task list when later.dog runs it, so the instruction to keep one
  had nothing behind it at release, and the phone's plan checklist stayed empty for those dogs.
  Fixed after the release by later.dog's own plan tool ([a dog's plan](dog-plan.md)).
- After a thank-you the first coding engine still wrote a short reply after its reaction at
  release. Fixed after the release: every engine is told to answer a bare acknowledgment with
  one emoji, which the app shows as a tapback ([tapbacks](tapbacks-2026-11-10.md)).

## Desktop 0.3.48, the evening of November 13

On top of the morning's release a person now has: a plan every dog keeps and shows, one
reaction for a bare thank-you, one plain line when a turn fails, a lost conversation picked
back up within the same turn, and long chats compacted by the engine itself.

| Piece | What | Identifier | Undo |
| --- | --- | --- | --- |
| Code | `main` adds the plan, the account leftovers, the disk breakdown, the plain failure lines, the second harness pass and the dictation helper fix | `d418a3dc4` | a new commit |
| The owner's home | Server code as a pushed bundle, in three steps through the day | bundle `bac091c0cefe`, label `33f77c93b` (no server file differs in `d418a3dc4`) | write the earlier pointer (hash `4f25bc29…`, label `0fd339b0f`) back to `dev-code/current.json` |
| Desktop | later.dog 0.3.48, signed, notarized and stapled | release `v0.3.48`, four files | none: apps that updated stay updated, so a fix is a newer version |
| Phone | Update on the `beta` channel from phone `main` `4887594`, published that afternoon | update group `0d2c9b4a-2edf-4bce-ad5f-cccb78e9990d` | `eas update:republish --group 673138be-0380-4869-88be-464b418b9233` |

The edge did not change. Other people's homes get the server changes with the next image
release.

### What was checked

- **Independent reviews.** The plan, the account leftovers, the disk breakdown, the failure
  lines and the second harness pass were each read by a reviewer who did not write them. The
  harness pass took four rounds; its last blocking finding (a dog shown as reconnecting while
  it rebuilt a conversation) is fixed, and the reviewer's own reproduction now reports the
  dog as working.
- **A real engine.** An isolated local server showed the lost-conversation fault on the code
  the home was running, then the engine compacting mid-turn and the fix answering within the
  turn ([harness and instructions](harness-and-instructions.md#seen-with-a-real-engine-2026-11-13)).
- **The whole suite** on the harness branch with `main` merged in: 1,332 files and about
  15,500 tests in eight parts, plus 320 edge tests. Six tests in five files fail, as they do
  on `main` without the branch: `server/laterdog/computer-runs.test.ts` (needs GNU `stat`),
  `server/agent-tool-policy.test.ts` (its list of outside-reading tools was not updated when
  mail search and read joined it), `server/cloud-lending.e2e.test.ts`, one write-heavy test in
  `server/cloud-lending.test.ts` and `scripts/testing/thinking-timer-ui.e2e.test.ts`.
- **The final head.** After the suite, three test files with outdated expectations were
  corrected (below). Typecheck, lint, those files, the handoff fixtures and the comment and
  naming checks passed on the commit that was merged; `main` holds exactly those files.
- **The owner's home.** No dog was working, the last save was three minutes old, and the
  earlier pointer was written down. The server process changed 70 seconds after the push;
  afterwards all 84 dogs and 160 chats were present and idle.
- **The desktop build.** The release script ran as a dry run from `d418a3dc4`: the packaged
  server smoke test passed, the app holds its dictation helper, and Apple accepted the app
  and the disk image. The built app was launched once in a sealed profile: the first-run
  screen rendered and its log held no error. The four files published are the ones that were
  checked (disk image 248,873,801 bytes, zip 250,877,746 bytes).
- **The published release.** Downloaded again from the public release: the checksum file and
  the update feed's hash match the zip, the signature is valid, the system accepts the app as
  notarized, it reports 0.3.48, and the feed installed apps read names 0.3.48.

### What the release build caught

- **0.3.47 went out without desktop dictation.** The first 0.3.48 build was accepted by
  Apple, and its log said the dictation helper could not be compiled and that packaging went
  on without it. The same line was in the 0.3.47 log, unread: the published 0.3.47 has no
  helper, while 0.3.45 and 0.3.46 do. The release Mac's Command Line Tools carry an old
  Swift module map that defines `SwiftBridging` twice, and 0.3.47 was the first release
  built from a fresh checkout, with no helper left over from an earlier build.
- The helper build now recognises that failure and compiles again with the stale file
  hidden, and the release script stops before notarizing when the app has no helper. The
  first 0.3.48 build was thrown away and the release was built again from `d418a3dc4`.
- A build that succeeds is not proof of what is in it. Before publishing, the new app's
  file list was compared with 0.3.46's. One server file is gone, removed on purpose with the
  account choice work, and the helper is there. The same comparison between 0.3.46 and
  0.3.47 shows the missing helper at once.

### What the suite caught

- A pull request merged that afternoon on focused tests alone (a truthful running state for
  jobs on a dog's computer) broke four dog-to-dog handoff fixtures. The owner's home never
  ran it. It was reverted before this release and stays out until those fixtures and a whole
  suite pass with it.
- Six tests in three files still expected what two other pull requests of the day had
  changed on purpose: "Issue recorded" beside View work, and a held chat's state without its
  hold details. The product was right and the tests were updated.
- The rule that follows: nothing merges to `main` on focused tests. The whole suite runs on
  the merged result first.

### Not proven

- Compaction at the engine's own default window, on a large model or on a real home, and
  anything of the second pass on the second coding engine with a real engine.
- The commits after the afternoon's real-engine run (the plain pick-up line, and showing a
  dog as working while it rebuilds) are covered by fixtures only: a repeat on the final head
  was refused by the engine account's weekly limit.
- That the owner's home runs exactly this bundle rests on the pointer and the changed server
  process, as with the earlier pushes.
- That dictation hears and types a word in 0.3.48. The helper asks macOS for speech and
  microphone access when it starts, so it was not run; it is inside the app, built for the
  Mac's processor, signed and notarized with it.
- The phone's message box has still not been seen with an on-screen keyboard on a device.
