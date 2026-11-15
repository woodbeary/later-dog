# Always on an approval: design (item 16, stage one)

Status: design only, for an attack review before any product code. Base: `main` 0651657. It meets item 45 (pull request 207, head 395406d), which is not merged yet.

Jacob's rule: "Allow once" always comes with "Always", and a dog never asks again for an approval he already gave. Item 45 adds a second rule: five kinds of action always ask, whatever the approval mode.

## For Jacob to decide (each with a recommendation)

**J1. Item 45's five kinds never offer Always.** These are a push that skips its checks, a new sign-in key in a cloud account, a delete outside the dog's folders, sending or posting as you, and paying. The cost you would notice: each lane's push from its home clone with the checks switched off (`LATERDOG_SKIP_HOOKS=1 git push …`) shows a card every time, not once.
- Recommended: never offer Always on the five. Remove the cause rather than the card: lanes push from their own cloud computer, where the checks run, so the push needs no card at all.
- The other choice: offer an exact Always (same command text, same folder) for the skip-checks push only. It would still ask once per lane, because every lane has a new clone and a new branch. Sends, payments, cloud keys and outside deletes still never get one.

**J2. Wide grants you already gave.** Main already stores two wide grants:
- "delete outside its folders, in every chat" (`DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY`);
- "use this app without asking" (`connector:<app>`).

207 still honours both.
- Recommended: keep honouring the grants you already gave, list them under Always allowed so you can see and remove them, and never offer a new one. Dropping them would make dogs ask again for something you said Always to.
- The other choice: retire them, so these now ask every time. The list shows them as no longer used.

**J3. One Always for a command covers that command in each of the dog's chats.** Each chat has its own folder (`task-workspaces/<dog>/<chat>`). If "the same place" means only the literal folder, a new chat asks again for `pnpm test` that you already allowed.
- Recommended: the same command text, run at the same place inside any of this dog's own chat folders, counts as the same thing. This is closed-list item C3 below. The card says the command runs whatever the files there say at that time.
- The other choice: literal folder only, so each new chat asks once.

## What happens today (read from main 0651657)

| Card | Its lasting choice | Where it is stored | Lost when |
|---|---|---|---|
| Engine tool (shell, edit, web, MCP) | "Allow for this chat" | Inside the engine's session: later.dog passes the engine's own suggested rules as `updatedPermissions` (`server/permission-proxy.ts:169`), and these are often a whole program prefix | The home restarts, the session is rebuilt, or another chat |
| Shell command, owner or admin, desktop only | "Always allow" with exact text, folder and engine | `command-allowlist.json`, per dog (`server/command-allowlist.ts`) | The dog is deleted |
| Another dog's request (`ask_bot`, `delegate_bot`) | "Always allow" with a key for the action and the teammate | The chat's `alwaysAllow` (`addAlwaysAllow`, `server/index.ts:11718`) | The approval mode changes (`:4191`) |
| Owner-guard delete outside | "Always allow", everywhere | The dog's `alwaysAllow` | Removed by hand |
| Connected app | "Always allow" for the app | The chat's `alwaysAllow` | The mode changes |
| Mac control | Always / Never for every dog | The Mac access setting | — |

The phone (`src/ui/Cards.tsx:131` in later-dog-phone 6bf7782) offers "Always allow" only where the card carries an `allowKey`, and otherwise "Allow for this chat". It never offers the exact command.

## Designs: who owns the key

**A. The engine owns it (ruled out).** The engine's own permission rules, as "Allow for this chat" uses today.
- Its rules widen by shape (`Bash(npm run:*)`), which is the failure mode of the abandoned attempt, and it chooses that width, not us.
- The rules live in the engine's session or in settings files inside the dog's own folder, which the dog can edit, so a dog could grant itself.
- Each engine does this differently, a restart loses it, and the phone cannot list it.

**B. The card owns it: a key computed from the shape of the request (ruled out).** This is the abandoned `fable/always-allow` at 3deb51af6. A key such as `run:git commit` or `files:edit` stood for a family of requests. Four attack rounds each found a new member of a family that runs or reveals something the person never saw:
- hooks reached through a worktree;
- secrets pushed through wide `git add`, `commit` and `push` keys;
- a planted git folder not named `.git`, with `core.fsmonitor` or `diff.external`;
- secret file names the matcher missed.

Each fix added a matcher, and the next round found what the matcher missed.

**C. The person's device owns it (ruled out).** The phone or the desktop would answer from its own list. Dogs work while devices sleep, two devices could disagree, and a guest's device would hold the owner's grants.

**D. The home owns it, keyed by exactly the thing approved (chosen).**
- The home computes a fingerprint from the pending request itself, never from anything a client sends.
- When the person taps Always, the home stores that fingerprint on the dog's record.
- When a later request has the same fingerprint, the home answers allow itself before a card is raised.
- Nothing is widened by shape. The only wider grants are the three closed-list items below, each limited by a structural rule rather than a name list.

## The chosen design in detail

### The fingerprint (what "exactly the thing" means)

| Request | Fingerprint |
|---|---|
| Shell command (Bash, Codex `exec`, the cloud computer's `exec`, `run_on_computer`) | Tool family + the command text byte for byte (Codex argv as its JSON array) + the real path of the folder it runs in |
| File write or edit (Write, Edit, MultiEdit, NotebookEdit, Codex file changes including `move_path`) | Tool family + the real path of each file + the sha256 of the new content |
| Any other tool (MCP tools, WebFetch, WebSearch, later.dog tools that ask) | Tool name + the sha256 of the input as canonical JSON (sorted keys, no whitespace) |
| Another dog's request | The existing peer key: the action + the teammate's id |

Rules that apply to every fingerprint:
- Nothing is normalised. A different quote, space, Unicode form, environment prefix or argument order is a different thing, and it asks.
- The dog's id is part of the key. A dog-made dog inherits nothing.
- The engine is not part of the key: the same text in the same folder is the same thing. Existing exact-command rules keep their engine field and keep matching as they do today.

### Closed list: the only grants wider than the fingerprint

**C1. A file: the same file, with any new content.**
- Offered only when every one of these holds when the card is raised:
  - the real path is inside one of this dog's chat folders;
  - no part of the path starts with `.`;
  - the file has one link;
  - the file is not inside a folder that passes git's own test for a repository folder (`HEAD`, `objects/` and `refs/` present, whatever its name);
  - git, run from the file's folder with a clean environment, does not place the file under `rev-parse --git-path hooks` or `--absolute-git-dir`, and does not fail.
- All of these are checked again at every later request, not only when the grant is given. Any failure or doubt shows a card.
- Outside the chat folders, Always remembers the exact change only (fingerprint above).
- Argument: content is the only thing that varies, and the file is the one the person read on the card. A file can still change what a later command runs, for example a test file read by `pnpm test`. That later command is its own exact grant whose card says it "runs whatever the files there say".
- Code that runs without any command is ruled out structurally rather than by name:
  - dot folders: `.git`, `.husky`, `.claude`, `.codex`, `.github`, `.mcp.json`, `.envrc`;
  - git's repository folders, found by git's own test;
  - git's own answer for the hooks folder;
  - everything outside the chat folders, such as `~/Library/LaunchAgents` and the rc files.

**C2. A message to the same teammate, with any words (the existing peer keys, kept).**
- Asking holds as long as the grant does.
- Handing work over holds only while the teammate's approval mode asks at least as often as the asker's. Without that check, a dog in Ask could get work done through a dog in Full.
- Argument: the words go only to another of the owner's own dogs. Everything that dog then does is governed by its own approvals and by item 45's list.

**C3. The same command at the same place in another of this dog's chat folders** (see J3).
- The folder in the key is stored relative to the chat folder when the command ran inside one. It matches the same relative place in any chat folder of this dog, and nowhere else: never the bot folder, a lent folder or another dog's folder.
- If the command's program word is `git`, the home first checks, with git itself and a clean environment, that the repository folder is a `.git` folder (or lies under `.git/worktrees/` or `.git/modules/`). It also checks that none of these settings is set anywhere git reads: `core.fsmonitor`, `core.hooksPath`, `core.pager`, `pager.*`, `diff.external`, `diff.*.textconv`, `diff.*.command`, `core.sshCommand`. Any of them set, or any doubt, shows a card.
- Argument: the text is identical and the folder belongs to the same dog. What differs is the files in the folder, and the card states that.

Nothing else is wider. Items rejected from the list:
- a program with any arguments;
- a tool with any input;
- a folder with any file;
- reads of any file (one wide read plus an exact push leaked a secret in round two);
- a host for web fetches.

### Commands that never get an Always, and why

These show Allow once and Don't allow, with one quiet line saying why:

- **Item 45's five kinds** (`alwaysAsks()` in 207 returns a match). The line reads "This one always asks."
- **A command that uses a value set elsewhere.** The 207 parser (`owner-guard.ts`'s tokenizer) finds a `$NAME`, `${…}`, `$(…)` or backtick whose value is not assigned in the same text. The same text could do something else next time. Line: "This one asks each time: the command uses a value set elsewhere."
- **A command or input holding a password or key**, which `redactSecretsInText` changes; this is already the rule for saved commands. Line: "This one asks each time: it holds a password or key."
- **A turn driven by a guest**, and a person who is not the owner or an admin. Line: "Only the owner can choose Always."

### Where the check runs, and its order

When a request opens (`request.opened` in `server/index.ts`), the checks run in this order. The first that applies decides:
1. 207's `alwaysAsks` shows its card.
2. The owner guard's hard refusals refuse.
3. **New: the lasting-allow lookup.** If it matches, the home answers allow, logs the decision with source `lasting-allow` and the rule's id, and raises no card.
4. Everything as today: the mode, owner-auto, saved commands and the card.

The same lookup is also used where later.dog itself asks: the cloud computer's `exec`, `run_on_computer`, peer requests and connected apps. 207 already brings those paths through one function.

- A guest-driven turn is never answered from a lasting allow.
- After the emergency downgrade (`stopBotForEmergencyApprovalDowngrade`), the dog's lasting allows are paused, not deleted. The list shows "Paused" with Resume.
- An ordinary mode change leaves them as they are: they are grants for single things, not for a mode.
- The engine never remembers anything. Every answer to an engine is allow-once; the home never passes `updatedPermissions` or `always` on, and "Allow for this chat" is removed. Codex already drops session options.

### What is stored and where

- A new store, `server/laterdog/lasting-allows.ts`, writes `lasting-allows.json` in the home's data folder (mode 600, atomic writes, the same checks as `command-allowlist.json`).
- Each rule holds: `{ version: 1, id, botId, kind: "command"|"file"|"tool"|"teammate", tool, text?, inputSha256?, contentSha256?, path?, folder?, folderInChat?, teammateId?, preview, grantedAt, grantedBy, fromThreadId }`.
  - `preview` is the redacted line the list shows.
  - Inputs are kept as hashes, not text, except for command text, which the person read on the card.
- At most 500 rules per dog. If the file cannot be read, nothing matches and every request asks.
- On first start, rules from `command-allowlist.json` are read in as `command` rules, keeping their engine field; that file is then left as it was. The `alwaysAllow` keys on dogs and chats keep working where they are (see J2).
- A grant is written only by `POST /api/bots/:id/always-allow` with the pending request's id. The home takes the fingerprint from its own copy of that request. Only the owner or an admin may call it. A card for one of the five kinds refuses with 409.

### How a person lists and removes them

- In the dog's settings, a section **Always allowed** lists every rule, newest first. This covers the C1 to C3 items, the exact fingerprints, the old `alwaysAllow` keys and the old saved commands.
- Each row shows what (the preview), where (the short folder or file, or "any of its chats" for C3), when, and **Remove**.
- Removing a rule takes effect at once: the next matching request asks.
- Deleting the dog removes its rules.
- The phone shows the same list with the same words (phone half, later).

## Words on the cards

Same strings on the desktop and the phone. No new colours: the existing primary, quiet and text-button styles are used.

Desktop (`PendingApproval.tsx`), one row: **Allow once** (primary) · **Don't allow** (quiet) · **Always allow** (text button). Below the row is the existing "What this covers ›" disclosure.

Phone (`Cards.tsx`): the existing pair row **Allow once** | **Don't allow**; under it, centred, **Always allow** with the ⓘ that opens the same line. The phone's primary label changes from "Allow" to "Allow once". Send cards keep "Send" and "Don't send", with no Always (item 45).

Where Always is not offered, its place holds one line of quiet text, not a button:

| Case | Line |
|---|---|
| Item 45 kind | This one always asks. |
| Value set elsewhere | This one asks each time: the command uses a value set elsewhere. |
| Holds a password or key | This one asks each time: it holds a password or key. |
| Not the owner, or a guest's turn | Only the owner can choose Always. |

"What this covers" lines (`{name}` is the dog, `{folder}` and `{file}` are short paths):

| Kind | Line |
|---|---|
| Command, literal folder | Always allow lets {name} run exactly this command in {folder} again without asking, in any of its chats. It runs whatever the files there say at that time. |
| Command, C3 | Always allow lets {name} run exactly this command in this place in any of its chats' folders without asking. It runs whatever the files there say at that time. |
| File, C1 | Always allow lets {name} change {file} again without asking, in any of its chats. |
| File, exact change | Always allow lets {name} make exactly this change to {file} again without asking. |
| Other tool | Always allow lets {name} do exactly this again without asking, in any of its chats. |
| Teammate, ask | Always allow lets {name} ask {other} without asking you first. |
| Teammate, hand work | Always allow lets {name} hand work to {other} without asking you first, while {other} asks you at least as often as {name} does. |

- Answered card: "Always allowed" (exists).
- Settings section: title "Always allowed"; row button "Remove"; empty text "Nothing yet. Tap Always allow on a card and it shows here."; when paused, "Paused" and "Resume".

Wire, for older apps: the card gains `lasting?: { offered: true; reach: string } | { offered: false; why: "always-asks" | "outside-value" | "secret" | "owner-only" }`. The answer is the existing `decideRequest` with `scope: "always"`. An app that sends only allow or deny keeps working, and one that knows only `allowKey` keeps working for the old peer cards.

## Attacked once by me

| What is stored | Hostile input | What it could run or reveal | Result |
|---|---|---|---|
| Command fingerprint | Same text, another folder, or a symlinked folder | — | Asks (real path in the key) |
| Command fingerprint | Quote, space, Unicode or `FOO=1` prefix variant | — | Asks (byte exact) |
| Command fingerprint | `$NAME` or `$(…)` set elsewhere (`export TARGET=~/.ssh`, then `rm -rf "$TARGET/x"`) | Anything | No Always offered |
| Command fingerprint | The folder's files change after the grant (`package.json` scripts, a test file, a Makefile, a planted git folder) | What the new files say | Residual, stated on the card. A planted git folder or a run-a-program git setting is caught by the git check for C3. **For the literal folder, the reviewer should test whether the git check must apply there too; I propose it does.** |
| Command fingerprint | `git push` recurring after a secret was committed | Publishes the secret | The repository's own push checks run (skipping them is item 45). Proposed defence in depth: before a lasting `git push` is answered, the home runs `redactSecretsInText` over the outgoing commits (`git log -p --no-ext-diff --no-textconv @{u}..HEAD`, clean environment). A hit, no upstream, or any doubt shows a card. |
| Command fingerprint | The shell keeps state between commands (alias, function, `PATH`) so `git status` runs another program | Anything | **Unknown**: whether each engine's shell keeps aliases, functions or `PATH` between commands. Proposed: before answering, resolve the program word with the home's fixed `PATH` and compare with the program resolved at grant time; a different file shows a card. Functions and aliases cannot be seen from the home, so this needs a check against each engine. |
| Command fingerprint | One of the five kinds stored earlier as a saved command (`git push --no-verify`) | Skips the checks | Asks: `alwaysAsks` runs first |
| C1 file | A symlink swapped in after the grant | Writes outside | Asks (real path at request time) |
| C1 file | A hard link to `~/.zshrc` | Writes outside | Asks (link count) |
| C1 file | A hook under `core.hooksPath=scripts/git-hooks`, `.husky`, or a worktree's common hooks folder | Code on the next commit or pull | Asks (git's own `--git-path hooks`, dot folders) |
| C1 file | A planted repository folder not named `.git`, with `core.fsmonitor` | Code on `git status` | Asks (git's test for a repository folder) |
| C1 file | `.mcp.json`, `.claude/settings.json`, `.envrc` | Engine starts a program | Asks (dot component) |
| C1 file | `CLAUDE.md` or `AGENTS.md` in a chat folder | Changes what the engine reads | Residual: changes instructions, runs nothing without a card. Listed for the reviewer. |
| C1 file | A secret copied into an allowed file | Revealed only if pushed or sent | Pushes and sends are separate grants (see the push row) |
| Tool fingerprint | The same tool name after an MCP server is replaced | The new server's code with the same input | Residual: adding a server already asks the person. Proposed: the key includes the server's command line as the home launches it. |
| Tool fingerprint | The same URL fetched again | Nothing new leaves: the input is identical | Allowed |
| Teammate key | Handing work from a dog in Ask to one in Full | Anything the Full dog can do | Holds only while the teammate asks at least as often |
| Teammate key | A dog-made dog | Inherited grants | None inherited |
| Store | A dog writes `lasting-allows.json` | Grants itself | **Unknown**: whether a dog's shell can write the home's data folder on a cloud home. If it can, it can already change the dog's record, so the store adds no new door. Must be checked on a real home. |
| Store | A client posts a fingerprint of its own | Grants anything | Refused: the home takes the fingerprint from its own copy of the pending request |
| Store | Unreadable or corrupt file | — | Nothing matches, everything asks |
| Any | A guest-driven turn | Owner's grants used by a guest | Never answered from a lasting allow |

## How it meets 207

- 207's `alwaysAsks()` runs before the lasting-allow lookup, so a stored rule can never answer one of the five kinds, even a rule saved before 207.
- A card for one of the five offers no Always and says "This one always asks." The grant route refuses it.
- The only exceptions are the old wide grants in J2, if Jacob keeps them.
- 207 at 395406d still offers Always on its outside-delete and connected-app send cards. With J1 and J2 as recommended, the build removes those two offers. This is a few lines in `PendingApproval.tsx`, plus the route refusal.

## What the build will touch

- New files: `server/laterdog/lasting-allows.ts` and its tests, and `shared/lasting-allows.ts`.
- Small edits: `request.opened` and the always-allow route in `server/index.ts`; `server/permission-proxy.ts` (stop passing suggestions); `src/components/PendingApproval.tsx`; `en.json`; the dog settings list.
- Phone: `src/ui/Cards.tsx` and the settings list.
- None of the files ROUND4 reserves for the Mac session. `server/drivers/claude.ts` is touched only if `allowSession` is removed there (one line, outside the compaction window).

## What only a real home or phone can prove

- An Always given in one chat holds in another chat of the same dog after a real home restart.
- The phone shows the card, stores the grant and lists it.
- Each engine's shell either keeps no aliases, functions or `PATH` between commands, or the program check catches it.
- A dog's shell cannot write `lasting-allows.json` on a cloud home.
