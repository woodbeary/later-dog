# Backlog, item by item (triage of 15 November 2026, about 02:15 PT)

Read-only triage. Sources: the 14 November handoff list (items 1 to 45), the maintainer's notes (items 46 to 49 exist only there), `origin/main` (77f6514dd, merge of #202), `origin/fable/rc-next` (7bf58d776, 135 files, not yet a pull request; its whole gate run 3 was at suite 7 of 8 at 02:12, no verdict yet), the phone repository (`origin/main` e5d4cf1), open pull requests in both repositories, and the lane briefs, reports and reviews on `/Volumes/fable-native`.

How sure: "verified" means I ran a git command that shows it (ancestry, file contents, a pull request body). "From notes" means only the maintainer's notes or the handoff say so. "Inferred" means from a title.

Tonight's phone update branch `fable/phone-rc3` (c7f2147) exists only on this Mac (not on origin). It merges `fable/phone-move` 4c1e68c, `fable/phone-context-rule` 18c5bc0 (also local only) and `fable/phone-calm` 28a3c46 (pushed). Verified by ancestry.

Counts (49 items): landed 9, landing tonight 18, in flight 9, needs the owner 2, not started 10, unclear 1. Items 32 and 37 are counted as landing tonight (phone half) although their desktop half is not started; briefs for those halves exist anyway.

## The list

1. A notification opens the chat it is about. `landed`. Phone #192 (merged 2026-11-14 18:10 UTC, title names it); OTA 39eadf09 from notes.
2. Waiting photos and files survive closing the app; Retry keeps the photo. `landed`. Phone #192 (title: "waiting files kept"); verified the merge, content from the notes' list of the update.
3. Phone and desktop agree on what a dog is doing. `landed`. Phone #192 ("one dog state"); desktop side is the work-state revert #195 plus main's own rule. Inferred from titles.
4. An answered card stays answered. `landed`. Phone #192; the held-answer gap after a kill is item 24.
5. The open chat does no extra work while other dogs are busy. `landed`. Phone #192, from notes (measured 0 folder calls where there were 50).
6. Unused phone code removed. `landed`. Phone #192, from notes' list of the update; not diffed.
7. His home runs exactly the released code. `landed`. From notes only (the home's own log line at 2026-11-14 06:40 UTC); I did not read the home. It changes again tonight when rc-next is pushed.
8. Dogs read connected Gmail without asking; sending still asks. `landed`. Commit 08280d639 is on `origin/main` (verified); cf00f0fae in rc-next pins it with a test. The decision is the maintainer's, his to overturn.
9. Message box against the keyboard, proof from a real phone. `needs the owner`. He must open the app on his phone and type in a chat; then someone reads the `Message box check:` lines with `/Volumes/fable-native/tmp/t/final/home-phone-crashes.mjs 24`. Nobody has read one yet (notes).
10. The context row on the phone. `landing tonight`. Phone code is live (#192); it stays hidden until his home has the route, which is #202 on main plus tonight's push of rc-next. Not on his home yet (verified: his checkout is at 088df2fea; notes say the home was left on older code on purpose).
11. The test gate and the release file check. `landing tonight`. `fable/suite-gate` is merged into rc-next (e832211e0, verified) with the fix-round commits for review findings 1 to 7 (613a4aa33, a22f6ca0a, 9ad06db7f, 5bfe19859, 44bd396c2, be27c279a, verified in the log). Open: the reviewer's last four gaps N1, N2, P, N3 (`/Volumes/fable-native/review/t-suite-gate/VERIFY-2.md`); branch `fable/gate-gaps` exists at rc-next's head with no commits.
12. The context view on the home and desktop. `landed`. #202 on `origin/main` (verified). The real-engine count fix ("full" instead of "summary", fable/fix-context-real, commits 555ff32ea, 5414b60cb, c6ea31120) is in rc-next, so the view is right only after tonight's push.
13. Disk archiving for a home. `in flight`. Parked, not under review: `fable/disk-archive` 4b4331c71 pushed, switched off; no pull request, no lane active (checked wave2 and worktrees). Not in main or rc-next (verified). Needs an attack review, a new home image, a test-home proof and his yes before it is switched on.
14. A truthful running state for jobs on a dog's computer. `in flight`. Draft #201 `atelier/work-state-truth-2` (head f40cc889), stacked on #199; no independent review; suite result on the cloud computer only (PR body).
15. The desktop design pass. `not started`. `fable/desktop-design-1` def4a22b6 is 14 commits not on main (verified); nobody has merged it with main or closed its review findings. Brief: `item-15.md`.
16. "Always" on an approval, redesigned. `not started`. Only the abandoned `fable/always-allow` 3deb51af6 exists. Brief: `item-16.md`.
17. Three findings in how a dog's turn is put together. `in flight`. Draft #200 `atelier/turn-assembly-findings` (head bf779457); its body lists exactly the three fixes; suite unfinished at last PR edit; no independent review.
18. Load rare tools on demand: default by model, proof. `not started`. Only the note correction is done (37b7d5a88 in rc-next). In the code the default is still on for every model unless the setting is "0" (`deferRareToolsEnabled`, verified in rc-next). Brief: `item-18.md`.
19. Text a dog reads is not an order. `landing tonight`. rc-next, lane fix-guidance: dog-guidance.ts line 157 and google.ts line 17 carry the sentence (verified by grep), plus 776655679, 88e85a2cf, d8dfd9189 for marking read text. The dog's own `atelier/read-text-not-order` 3af452dae has no pull request and is superseded. Whether the harness doc and measure script were updated: not checked.
20. The folder check `validateBotCwd`. `unclear`. The handoff says draft #200 holds items 17 and 20; #200's body mentions only 17; no commit on any desktop branch touches `server/bot-cwd.ts` (checked #199, #200, #201 and rc-next; `validateBotCwd` is called at seven places in `server/index.ts`). The notes say the report sits in a dog's home folder, which I cannot read.
21. Remove desktop and server code nothing uses. `not started`. Survey only: `/Volumes/fable-native/tmp/t/lean/SURVEY.md`; no branch (checked). Brief: `item-21.md`.
22. Deleting a chat leaves its files on the home. `in flight`. Lane `steward-b` step 3 (`briefs/wave2/steward-b.md`, branch `fable/steward-b`, started 02:10, no commits yet): moves a deleted chat's folder aside for seven days. The owner's written yes is still needed before anything deletes; the brief's step 3 does not stop for it. See "owed".
23. Fresh engine count shown as current, both apps. `landing tonight`, in part. The one-sided rule (b847daf07, `fallsShort` in shared/context-breakdown.ts, verified) is in rc-next and in `fable/phone-context-rule` 18c5bc0 (in rc3). The other half, the heading showing the engine's own total, has no diff in `ChatUsageButton.tsx`: not done.
24. A question card can be answered again after a kill. `not started`. No branch touches `deploy/laterdog/home/src/desk.ts` for held answers (checked). Brief: `item-24.md`.
25. Open and continue any of a dog's chats on the phone. `in flight`. Draft phone #193 (head e7f0fec), stacked on #195's head 6da5da6; not in rc3 (verified); not reviewed independently.
26. The real engine answers the context request after a real turn. `landing tonight`. Done on a probe by the maintainer's session (notes 14:45: "summary" was 16 to 55% off, "full" within 1%; logs in `study/live/context-usage-20261114/`); the fix is in rc-next. Not yet seen through the final home build.
27. The lost-conversation fix on the final build, real engine. `not started`. The one re-check on file (`study/live/claude-lost-final-20261113-2220/RUN.md`) stopped at a usage limit; the notes record no later run. Brief: `item-27.md`.
28. Dictation in desktop 0.3.48 hears a word. `needs the owner`. One press of the mic in the installed app; the maintainer's test was inconclusive (notes).
29. Not yet seen in real use: second-engine compaction, compaction at the normal window, old facts without recall, cache lifetime. `not started`. No record of any run. Brief: `item-29.md`.
30. The Accounts screen shows the real limit. `in flight`. Draft #199 `atelier/real-account-limit` (server half; head 1bd2c91a); the phone half is in #194. Paid credits: PR body not read in full, unverified.
31. One usage list, not two. `in flight`. Draft phone #194 `atelier/one-accounts-list` (head 83819e29). The desktop split ("wherever it repeats itself") is not in any branch I found.
32. One team block for a dog coordinating dogs. `landing tonight`, phone half. `fable/phone-calm` (in rc3) carries draft #195's older commit 10eb0fc plus its review-round commits; #195's own head 6da5da6 is four commits newer and not in rc3 (verified). Desktop half (one place to watch a team): `fable/calm-desktop` worktree exists at rc-next's head with no commits. Brief for the desktop half: `item-32.md`.
33. How a dog drives a browser and its computer. `not started`. Nothing measured or built (checked rc-next and branch names). Note draft #203 is titled "Item 33" but is about Gmail (see contradictions). Brief: `item-33.md`.
34. A coordinator receives and acts on its helpers' results. `landing tonight`. Lane fix-results in rc-next (13abd1406 ... e100542c5, 458504847, 3ef02a1ca); review 3 said ready to combine. Leftovers are in flight as lane `results-2` (`briefs/wave2/results-2.md`, `fable/results-2`, started 02:10, no commits).
35. The summary when a chat moves account or engine. `landing tonight`. Lane fix-summary in rc-next (0f14146b7, 522a93675, 74edd73e7, 38779e0d1, 0397f9248 and others).
36. A dog's cloud computer that fails to start. `in flight`. `fable/fix-computer` 13764019f pushed, not in rc-next. Review 4 (`review/wave-computer-2/REVIEW-4.md`) said ready after fixes; round 4 report says they were made; no review of that round seen. The service half needs `pnpm run deploy:worker` in `deploy/laterdog/computers` (notes).
37. A chat that stays readable while a dog works. `landing tonight`, phone half. phone-calm (work rows fold, notices do not add rows). Desktop: only the old-summary-row line is in rc-next (2a9e0ba1b, 5b0eabb7e, DigestChip changes); folding tool rows and alerts as one updating line on the desktop is not started. Brief: `item-37.md`.
38. Slash commands. `in flight`. Lane `slash` (`briefs/wave2/slash.md`, `fable/slash-commands`, started 02:10, no commits). The brief is desktop and server; the phone part is not in it (see owed).
39. A dog coordinates by itself. `landing tonight`. bfb6a3d02, d091092e2 in rc-next (verified in the log).
40. Clean the standing instructions. `landing tonight`. rc-next: 138d930f6, d8f298a3b, 26613c705, 285e7921b, 20db005b6, 8af141042, d5792bca2, f15381daf. The review's must-fix (a line the engine only says sometimes) is addressed by 26613c705.
41. Nothing that decides what a dog keeps runs on the small old model. `landing tonight`. 81e07f0e2, c9ac49da8, 95b605e0c, 0397f9248, 7bf58d776 (prices for the short model names).
42. Long single turns. `not started`. No commit tells dogs to wait with one call or read in parts (grep of dog-guidance.ts); the notes list it as wave 2 not started. Brief: `item-42.md`.
43. The home's disk. `landing tonight`. Stage A in rc-next: disk ladder (01c3f67e0 and later, `server/laterdog/disk-ladder.ts`), temp folder per chat (ac4ef8693), last-resort clearing (40ba07bd4). The rest is lane `steward-b` (in flight) and item 13. Whether the dogs removed today's clones: not known (notes: only about 270 MB freed by the first clean; later free space not read).
44. later.dog Dev starting without its dependencies. `landing tonight`. Lane fix-devstart in rc-next (e110802ff, 35ff7e0d7, 2f7973cb5, 909086a1b).
45. What still asks. `not started`. No branch (checked); listed as wave 2 not started in the notes. Brief: `item-45.md`.
46. Question cards take a typed answer and show the question once (notes only). `landing tonight`. phone-calm 80856a1, 9007f2c, 13d54e8, 439e281 (verified in log). A real home check that a typed answer after Other reaches the card is owed (notes).
47. A to-do list that stays true (notes only). `landing tonight`. Dog side: d5792bca2, 187a279f9 in rc-next. App side: phone-calm 42c2975 ("may be out of date"). Hiding a finished plan: drafts desktop #204 and phone #196 are `in flight`.
48. No internal tool name ever reaches the screen (notes only). `landing tonight`, phone half. phone-calm b279dce (Background work screen). The desktop side was not looked at; no desktop commit named for it.
49. "Move this chat here" does not work (notes only). `landing tonight`. `fable/phone-move` 4c1e68c, 50b3eb3, be955fa (in rc3); the phone showed the old account as ticked. Draft phone #194 touches the same control; two paths, decide which wins.

## Not on the list but owed

- Does "Move this chat here" also change the dog's default account? Open question for the owner (notes 11-14 20:25); currently it moves the chat only.
- The phone part of slash commands: the `slash` brief covers the home and desktop only; the "/" list in the phone's message box, saving a command on the phone, and the phone update are not in any lane.
- Turn-end process cleanup is logging only (`LEFTOVER_MODE = "observe"`, `server/laterdog/turn-leftovers.ts` line 16). Switch it to acting only after reading his home's log for the "would stop" lines; `steward-b` step 5 writes down what must be seen first.
- Gate gaps N1, N2, P, N3 (item 11): stale reports shared between runs, `OFFLINE`/`NO_BROWSER` still printing PASS, typecheck and lint with no required output, a missing `server/*.js` not stopping a release.
- Landing steps: rc-next is not a pull request yet; whole gate run 3 unfinished; then test home, one push to his home (pointer saved first), `deploy:worker` for the computers service, and the phone update from rc3 (rc3 and phone-context-rule are local branches only; push them before anyone else needs them).
- phone-calm's last fix round (twelve items) has no review after it (REVIEW-2 predates 28a3c46). Also ask: do the phone-calm and #195 heads need merging (4 commits from #195's head are missing from rc3)?
- None of the dog drafts (#199, #200, #201, #203, #204 desktop; #193, #194, #195, #196, #197 phone) has an independent review or a gate run (notes 00:10, handoff 0a).
- Drafts with no number on the list: #203 (Gmail connects without the person creating anything in Google; needs a one-time Google step from the owner), #204 and phone #196 (a finished plan is not shown), phone #197 (a sent message stays on screen when an older list arrives).
- `results-2` items: a request that stays "running" after its dog is done (three seen on his home), group chats waiting for every result, `openHandoffs` unused, `threadId` on `WireExchange`.
- Steward stage B: one copy of a repository per home, upper disk rungs, engines as a separate user (document only).
- Item 31's desktop half, item 23's heading half, item 48's desktop half.
- The owner's question, asked once: does the next agent merge and release, or bring each pull request? (handoff section 0).
- The handoff names `server/laterdog/always-allow.ts` and `git-ask.ts` as files to read: they are on the abandoned branch only (see item 16 brief).
- Older open pull requests not on the list: #172, #174, #178 (native Mac app), #146, #113, phone #163.

## Contradictions between sources

- Handoff section 0 and 5 say item 12 still awaits merge at `75b879dfb`; it merged as #202 the same afternoon (main 77f6514dd), and the notes then found its engine count wrong; the fix is only in rc-next.
- The handoff gives main as 088df2fea; `origin/main` is 77f6514dd (his checkout `~/code/dog` is deliberately still at 088df2fea).
- Item 18: handoff section 5 says "built and off"; section 0a, the notes and the code say on by default.
- Item 20: handoff 0a says draft #200 holds it; #200's body covers item 17 only.
- Item 33: handoff 0a gives 33 to browser and computer control; draft #203 calls Gmail connection "Item 33". Section 8a still headlines the browser item as 32.
- Items 46 to 49 appear only in the notes; the handoff file stops at 45. The notes' own 10:35 draft numbering is marked superseded there.
- Item 16: the handoff says to read `server/laterdog/always-allow.ts` and `git-ask.ts`; neither is on `origin/main` or rc-next (only on the abandoned branch).
- Handoff 0a says Atelier "never saw" the merge question; the notes (00:10) say "he was told" the push follows the gate. Different subjects, noted for completeness.
- Notes 00:10 list phone-calm at 80856a1 needing review; it is now at 28a3c46 with a further fix round. #195 (head 6da5da6) and phone-calm's base (10eb0fc) differ by four commits.
