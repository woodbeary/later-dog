# later.dog fix wave, 2026-11-14: what every lane shares

later.dog in three lines: a person talks to AI helpers ("dogs") from a desktop app and a phone app; a server (the
"home", one container per person) runs each dog on a coding engine, most often Claude Code, and adds its own
instructions and tools; dogs can create other dogs and hand them work. The owner, Jacob, handed a large list of work
to his dogs this morning and it went wrong in ways an audit found. You fix one of those ways. I am the maintainer
and coordinator; you work alone in one git worktree and report to me. Nothing you build is merged, pushed to a home
or released by you.

## Evidence (read only, private)
`/Volumes/fable-native/study/audit-20261114/`: `AUDIT.md` (what the dogs did today, from their traces),
`PROMPT-REVIEW.md` (what dogs are told, and what repeats the engine), `SUMMARY.txt`, and per dog
`<Dog>-<id>-events.json` and `-messages.json` (large: read them with small scripts, never whole). These hold the
owner's real chats. Never copy their content into the repository, a commit or a test; write fixtures with invented
text. `PROMPT-REVIEW.md` discusses other products' instructions: nothing from it may be named or quoted in the
repository.

## Rules
- Read `AGENTS.md` first. Node 24 and pnpm: start shell commands with `source ~/.nvm/nvm.sh && nvm use 24 >/dev/null &&`.
  Never `npm`, never `npx`, never `pnpm install` (`node_modules` in your worktree is a shared link).
- No comments in code. Never name another product in code, tests, docs or commit messages, except an engine
  later.dog runs. `pnpm exec vitest run scripts/no-comments.test.ts scripts/brand-links.test.ts` before each commit.
- New behaviour goes in new files under `server/laterdog/`; keep the diff in `server/index.ts` and
  `server/drivers/claude.ts` as small as it can be. Other lanes are editing those two files today.
- This Mac has 8 GB of memory and several lanes run at once. Every typecheck, lint and vitest command goes through
  the queue: `/Volumes/fable-native/tmp/heavy.sh pnpm exec vitest run <files>`, `/Volumes/fable-native/tmp/heavy.sh
  pnpm typecheck`. Focused files only, never the whole suite (I run it once on the combined result). Prefix any
  other node command with `TMPDIR=/Volumes/fable-native/tmp/t`. Write nothing to `/tmp`.
- **Run every command in the foreground and wait for it. Start no background tasks. Send me nothing until you are
  done: one final report.** Spawn no helper agents.
- Hard limits: never touch `/Users/jacoblopez/code/dog` (the owner's live checkout: his app is running from it right
  now and pushes saved server code to his real home), any other worktree, his home, chats, accounts or phone. Start
  no real engine or model: the fake engines under `server/testing/` are your engines. Call no outside service.
- Each change has a test that fails before it. Show that: stash or revert the change, run the test, paste the
  failing line, restore.
- One fix per commit, subjects in plain words that say what changes for the person. Push after each with
  `/Volumes/fable-native/tmp/heavy.sh git push -u origin <your branch>`. Never skip the hooks (`--no-verify`,
  `LATERDOG_SKIP_HOOKS`), never push to `main`, never force. No pull request: I open it after an independent review.
- If the code shows that something in your brief is wrong, stop that part and say why. Do not build around a wrong
  premise, and do not add a mechanism where the existing state already answers the need.

## Report (your final message, under 350 words; also write it to `/Volumes/fable-native/tmp/t/wave/<lane>/REPORT.md`)
What a person sees differently. The cause, where the task was a fault. Each commit with the test that failed before
it. Commands with real exit codes and counts. The pushed branch head. A plain split between what you ran and what
you inferred. What only a real engine or a real home can prove, as the exact check I should run. Anything you chose
not to do and why.
