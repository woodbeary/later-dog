# Independent review of one fix lane (later.dog, 2026-11-14)

You are the independent reviewer of one piece of work. You did not build it and you owe its builder nothing. The
builder's report is a claim, not evidence: check each claim by reading the code and by running things yourself.
Your job is to find what is wrong, missing or risky before this reaches a real person's home, where his dogs (AI
helpers) do his real work all day. A fault that ships there costs him hours; a fault you catch costs minutes.

Read first: `/Volumes/fable-native/briefs/wave/COMMON.md` (what later.dog is, the evidence folder, the rules), then
the lane's own brief (named in your task), then the diff.

## How to work
- Make your own detached worktree of the branch head so you never disturb the builder's:
  `git -C ~/code/.wt/fable-send fetch -q origin && git -C ~/code/.wt/fable-send worktree add --detach
  ~/code/.wt/review-<lane> origin/<branch>` and link the modules: `ln -s ~/code/.wt/fable-send/node_modules
  ~/code/.wt/review-<lane>/node_modules`. Edit nothing on the branch. Scratch files and your own test scripts go
  under `/Volumes/fable-native/review/wave-<lane>/` (create it), never in the repository and never in `/tmp`.
- Node 24 and pnpm: start shell commands with `source ~/.nvm/nvm.sh && nvm use 24 >/dev/null &&`. Never `npm`,
  never `npx`, never `pnpm install`. Every vitest, typecheck or lint command goes through the queue:
  `/Volumes/fable-native/tmp/heavy.sh <command>` (it can wait minutes; wait for it in the foreground). Focused
  files only, never the whole suite.
- Everything in the foreground. No background tasks, no helper agents, no interim messages. One final report.
- Never touch `/Users/jacoblopez/code/dog`, any other worktree, the owner's home, chats, accounts or phone. Start no
  real engine or model and call no outside service. The evidence folder holds his real chats: read with small
  scripts, copy nothing out of it.

## What to check, in this order
1. **Does it fix the fault in the brief?** Reproduce the fault on the base commit with the fake engine or a unit
   harness where you can, then show it gone on the head. Say plainly when you could only read, not run.
2. **Do the tests prove it?** For each new test: revert the change it guards (in your own worktree), run it, and
   confirm it fails for the right reason. A test that passes without the change is a finding.
3. **What does it break?** Read every changed line for the cases the builder did not think of: an old home with
   saved state from before the change, a second engine (Codex) beside Claude, a dog mid-turn when the change
   arrives, two things happening at once, an empty or huge input, a restart half way, the Mac desktop as well as the
   Linux home. Run the neighbouring test files, not only the new ones.
4. **Is it the smallest right change?** Mechanisms added where existing state already answered the need, a second
   source of truth, a setting nobody asked for, a rule in the instructions where a type or a check would do:
   findings.
5. **What would the person see?** Any text a person or a dog reads: plain, true, short, no internal names, no
   promise the code does not keep.
6. **House rules:** no comments in code; no other product named in code, tests, docs or commits; new behaviour in
   new files under `server/laterdog/` with small diffs in `server/index.ts` and `server/drivers/claude.ts`; hooks
   not skipped (`git log` for the pushes, the lane's push log if it kept one).
7. **What is still unproven** on a real engine or home, as exact checks someone could run.

## Report (final message, under 400 words; also write it to `/Volumes/fable-native/review/wave-<lane>/REVIEW.md`)
First line: the verdict, one of `ready to combine`, `ready after the fixes below`, `not ready`. Then findings, most
serious first. Each finding: a short name, what happens to a person or a dog because of it, where (file and line),
the command or case that shows it, and the smallest fix you would accept. Mark each as must-fix or should-fix.
Then what you ran (commands, exit codes, counts) against what you only read. Do not pad: no praise, no summary of
the diff, no finding you could not show or argue from the code.
