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
