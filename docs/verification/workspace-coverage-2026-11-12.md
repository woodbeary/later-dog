# Workspace coverage, 2026-11-12

Where each part of the workspace assignment stands: what is merged, what is in review, how each
piece was checked, and what is still open. Each claim says what kind of evidence it rests on:
**unit** (tests), **fixture** (an isolated fake-engine server driven through the real renderer or
its API), **test home** (the isolated Cloud home for test accounts), **production**, **Mac app**,
**iPhone**. Nothing below was checked on the Mac app or an iPhone unless it says so.

Nothing in this record is merged, deployed or released. Every pull request named is a draft
waiting for the owner.

## In review

| Pull request | What the person gets | Evidence | Open |
| --- | --- | --- | --- |
| #176 | Card answers wait for the home; every send keeps its words as Not sent on a final failure; a held message is confirmed with the home before it is called Not sent; a failure is always shown in words | unit; fixture (chat turn recipe) | Not run on a test home or the edge |
| #177 | One work state per chat from the home; dog-to-dog rows read the handoff record and open to the real request and reply; what ran a turn | unit; fixture (chat turn, dog-to-dog coordination, native activity recipes); one screenshot reviewed | No engine reports its own exit; a stop by home restart is not recorded per chat; signals are lost on a home restart |
| #179 | A card answered in a group chat is saved on the home; a group chat says what it is doing; each dog's row follows its own handoff | unit and route tests; fixture (coordination recipe) | The native activity recipe did not finish on a loaded machine (the browser did not open in time) |
| #181 | What a finished turn changed: files, a pull request link, commands run | unit | Not run on a fixture; Claude and Codex only; one Codex stop test fails here and on the branch below under load |
| #180 | The route guard passes on `main` again (two handlers moved to `server/routes`) | unit; the tapback end-to-end test | |
| #161 | Saved quota holds reconciled with a fresh allowance; paid credits; native context windows | unit on the rebased head (555 tests) | Its fixture checks and screenshot review not rerun |
| #175 | Edge trust follow-ups | unit at its head (320 edge tests) | Narrowed, not closed: a request the edge answers by itself while the home is up; needs an edge deploy |
| #178 | A native Mac app (Rust on AppKit) built beside the released one | unit (72); fixture; snapshots reviewed; measured (the note in #178) | Far from feature parity; launch time not measured cleanly |
| later-dog-phone #184 | The phone keeps the words and says the outcome for every send, as the desktop does | unit (2,130 of 2,131 on a loaded machine; the miss passes alone) | Nothing on a simulator, an iPhone or the real edge |

## Checked without a code change

- **Cold restore, test home.** A marked message was sent to a dog on a test account at 07:04 UTC
  and answered. The home was left alone; at 07:59 UTC it answered every request with "waking", so
  its container had stopped. Once it was up, the message, the reply and the turn's digest were all
  in the chat. This is the image the test home runs today, not the branches above. Found on the
  way: the test driver's `summary` kept answering "ready" for the whole hour, so it does not show
  whether a home's container is running.
- **Decision and extraction models.** The saved receipts on `atelier/decision-eval-receipts` were
  scored again offline with `scripts/decision-eval.ts score`; the counts match
  [the evaluation note](decision-eval.md). No model was called again.

## Not done

- **Released desktop.** The latest release is 0.3.46; 0.3.47 is prepared on `main` and not
  published. None of the work above is in it.
- **Mac app measurements.** Cold launch, typing, chat switching, scrolling, streaming and the
  whole process tree of the released app have not been measured on a Mac. The only Mac numbers
  are the idle comparison in the native app note in #178.
- **iPhone.** No visual audit, no device run of the phone changes, no update published.
- **Held messages end to end.** The matrix of slow wake, disconnect, lost receipt, retry, session
  renewal, app restart, home restart and concurrent cancel has not been run against the test home
  and the real edge.
- **Group-chat routing "nobody" outcome**, listed as open in the evaluation note.
- **Measurement notes** in #172 and #174 are unfinished and unreviewed.
- **Changed-file lists for other engines**, page and file links, and results on group-chat
  handoffs.
- **The native app**: sign-in to a real home, cards, approvals, Markdown, group chats, settings,
  accounts, signing.

## Limits of this record

The Mac these checks ran on had 8 GB of memory and other work running throughout, with load
averages from 4 to over 50. Timed results from it are not reported as clean, and several test
runs needed longer timeouts than the suite's defaults.
