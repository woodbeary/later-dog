# Always on an approval: design (item 16, stage one, revision 2)

Status: design only, for a second attack review before any product code. Base: `main` 0651657. It meets item 45 (pull request 207, head 395406d), which is not merged yet. Revision 2 answers review 1 (Relay, `handoff/round4/item-16-REVIEW-1.md`); the answer to each finding is at the end.

Jacob's rule: "Allow once" always comes with "Always", and a dog never asks again for an approval he already gave. Item 45 adds a second rule: five kinds of action always ask, whatever the approval mode.

## What changed in revision 2, in one paragraph

Review 1 ran a marker program through every wider grant revision 1 offered, and through the exact shell grant itself: the folder in the key was not the folder the command ran in, the git check was a name list, a lasting file grant plus a lasting script run ran anything, and a link or remote changed under an unchanged command. Each hole was in the same place: a shell command runs whatever its folder, its git folder, its shell start files, its links and its remotes say at that moment, and the home cannot record all of that. Revision 2 removes instead of matching: **shell commands get no lasting Always**, the file and wide-command closed-list items are gone, and what remains lasts only for things whose whole effect is in the request the person read.

## For Jacob to decide (each with a recommendation)

**J4 (new, first). Shell commands offer no Always.** This breaks "Allow once always comes with Always" for one kind of card: a shell command.
- Where you would notice it: your own dogs in Ask or Auto run in owner-auto (`ownerTurnMode`, `server/laterdog/auto-review.ts:11`), which answers shell commands without a card already; they see no shell cards except item 45's five kinds, which never offer Always anyway. You would notice it with Auto-review on (the reviewer's held commands), in Custom mode, and on a shared workspace or a guest's turn.
- Recommended: accept it. Every pin the home can record has an input outside it: a package's folder of installed code, a global git or package config, the shell's start file, the environment, a remote server. Four rounds of the abandoned attempt and review 1 found the leaks exactly there.
- The other choice, for later and only with its own attack review: a **pinned Always** (below, "Ruled out for now: the pinned command"). It asks again after any change to what it pins, and it still cannot see installed packages or global configs.

**J1. Item 45's five kinds never offer Always.** Unchanged, and now true in code only once the build checks `alwaysAsks` before both old keys (finding 7).
- Recommended: never offer Always on the five. The cost: each lane's push from its home clone with the checks switched off shows a card every time. Remove the cause: lanes push from their cloud computer, where the checks run.
- The other choice: an exact Always for the skip-checks push only. With J4, that would be the only shell command with an Always, which this design advises against.

**J2. Grants you already gave (changed by review 1).** Main stores three:
- "delete outside its folders, in every chat" (`DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY`);
- "use this app without asking" (`connector:<app>`);
- saved exact shell commands (`command-allowlist.json`, owner or admin, desktop only). Review 1's findings 1 and 4 apply to them as they work today: the folder stored is the engine's start folder, and nothing pins what the arguments point at.

Recommended (Relay's view, which I share): stop answering from the outside-delete key and from saved shell commands, and answer from `connector:<app>` only for calls `alwaysAsks` does not match. Since every send, post or payment is matched, the app key then covers only an app's other calls. All three stay in the Always allowed list, marked "No longer used", with Remove. The other choice: keep honouring them, knowing two of them answer item 45's kinds today and a dog's shell can write the file that holds them (finding 6).

**J3. One Always covers that dog's other chats (changed by review 1).** With J4, no remaining grant depends on a folder, so "literal folder or any chat" no longer arises for commands.
- Recommended: an Always for a tool call, a teammate message or an exact file change holds in every chat of that dog. Each of those keys already names everything that differs (the tool and its input, the teammate, the real file and its content before).
- The other choice: per chat. It costs a card per new chat for the same thing.

## What happens today (read from main 0651657)

| Card | Its lasting choice | Where it is stored | Lost when |
|---|---|---|---|
| Engine tool (shell, edit, web, MCP) | "Allow for this chat" | Inside the engine's session: later.dog passes the engine's suggested rules as `updatedPermissions` (`server/permission-proxy.ts:169`), often a whole program prefix | The home restarts, the session is rebuilt, or another chat |
| Shell command, owner or admin, desktop only | "Always allow" with exact text, folder and engine | `command-allowlist.json` | The dog is deleted |
| Another dog's request (`ask_bot`, `delegate_bot`) | "Always allow" with a key for the action and the teammate | The chat's `alwaysAllow` (`server/index.ts:11718`) | The approval mode changes (`:4191`) |
| Owner-guard delete outside | "Always allow", everywhere | The dog's `alwaysAllow` | Removed by hand |
| Connected app | "Always allow" for the app | The chat's `alwaysAllow` | The mode changes |
| Mac control | Always / Never for every dog | The Mac access setting | — |

## Designs: who owns the key

**A. The engine owns it (ruled out).** Its rules widen by shape (`Bash(npm run:*)`), they live in the session or in settings files inside the dog's folder, each engine differs, a restart loses them, and the phone cannot list them.

**B. The card owns it, a key from the request's shape (ruled out).** The abandoned `fable/always-allow` at 3deb51af6 (`run:git commit`, `files:edit`). Four attack rounds each found a family member that ran or revealed something unseen: hooks through a worktree, secrets pushed through wide git keys, a planted git folder with `core.fsmonitor` or `diff.external`, secret file names a matcher missed.

**C. The person's device owns it (ruled out).** Dogs work while devices sleep, two devices disagree, and a guest's device would hold the owner's grants.

**D. The home owns it, keyed by exactly the thing approved, and only for things whose whole effect is in the request (chosen).**
- The home computes the key from its own copy of the pending request, never from anything a client sends.
- Tapping Always stores the key; a later request with the same key is answered by the home, after `alwaysAsks` and the hard refusals and before any card.
- What qualifies is decided by where the effect comes from, not by a list of names: if anything outside the request (a folder's files, a git folder, a link, a remote, a start file, code the dog can write) decides what happens, there is no Always.

**E. The home owns it, with pins on everything the thing depends on (ruled out for now; J4's other choice).** See "Ruled out for now: the pinned command".

## The chosen design in detail

### What can get an Always, and its key

| Request | Gets Always when | Key |
|---|---|---|
| A tool from an MCP server the person set up in later.dog (connected apps, bot-owned servers in settings, later.dog's own tools that ask) | Always, except the cases under "No Always" | Dog id + server name + sha256 of the server's launch line as the home starts it + tool name + sha256 of the input as canonical JSON |
| WebFetch, WebSearch | Always, except the cases under "No Always" | Dog id + tool + sha256 of the canonical input (URL or query) |
| A file write or edit (Write, Edit, MultiEdit, NotebookEdit, Codex file changes) | The real path is inside one of the dog's own folders and is not a link | Dog id + tool + real path + sha256 of the file before (or "absent") + sha256 of the canonical input |
| A message that starts a teammate's turn (ask or hand work, one key) | The teammate, for a teammate-started turn, asks at least as often as the asker does now | Dog id + `start-turn` + teammate id |

Rules for every key:
- Nothing is normalised: another quote, space, Unicode form or key order is another thing, and it asks.
- The dog's id is in the key. A dog-made dog inherits nothing.
- The home stores the key as a hash and a redacted preview, never the input text (finding 10).

### No Always, and why (each with its card line)

- **Item 45's five kinds** (`alwaysAsks` matches). Line: "This one always asks."
- **Any shell command**: Bash, Codex `exec`, the cloud computer's `exec`, `run_on_computer`, the lent Mac's `run_command`. Line: "This one asks each time: a command runs whatever its folder says when it runs."
- **A tool from a server defined in the dog's own folder** (`.mcp.json` and project servers, `projectMcpServers`, `server/drivers/claude.ts:245`): the server's code is a file the dog can change. Line: "This one asks each time: its tool comes from a file the dog can change."
- **An input that holds a password or key** (`redactSecretsInText` changes it). Line: "This one asks each time: it holds a password or key."
- **A file change whose real path is a link, leaves the dog's folders, or cannot be read.** Line: "This one asks each time: later.dog cannot tell which file this changes."
- **A turn whose root was not started by the owner or an admin**, on every home (finding 9). Line: "Only the owner can choose Always."

### Where the check runs, and its order

When a request opens (`request.opened`), and for a teammate turn at `coordinate-bots`, the first that applies decides:
1. 207's `alwaysAsks` shows its card. It runs before every stored grant, the old ones included (finding 7: in `connectorSendDecision` before the always-allow and this-turn lines, in `settleOwnerAutoPermission` before `ownerAllows`).
2. The owner guard's hard refusals refuse.
3. **New: the lasting-allow lookup.** The home recomputes the key from the request (for a file, it reads the file's real path and current content first) and answers allow on a match, logging source `lasting-allow` and the rule id.
4. Everything as today.

- The engine never remembers anything: every answer to an engine is allow-once, `updatedPermissions` is no longer passed on, and "Allow for this chat" is removed.
- After the emergency downgrade, lasting allows are paused, not deleted. An ordinary mode change leaves them.
- The cloud computer's `exec` and `run_on_computer` are not part of this design (finding 13): they never ask outside item 45's kinds, and if they ever do, they are shell commands, so no Always.

### What is stored and where

- A new store, `server/laterdog/lasting-allows.ts`, writes `lasting-allows.json` in the home's data folder (mode 600, atomic writes, the same checks as `command-allowlist.json`).
- Each rule: `{ version: 2, id, botId, kind: "tool"|"web"|"file"|"teammate", keySha256, preview, where?, grantedAt, grantedBy, fromThreadId }`. `preview` is the redacted line the list shows, at most 80 characters; `where` is the short file path or the teammate's name.
- At most 500 rules per dog. An unreadable file matches nothing, so everything asks.
- A grant is written only by `POST /api/bots/:id/always-allow` with the pending request's id; the home takes the key from its own copy. Only the owner or an admin of the turn's root may call it. A card with no Always refuses with 409.

### How a person lists and removes them

- Dog settings, section **Always allowed**: every rule, newest first, plus the old keys and saved commands (J2), each with what, where, when and **Remove**.
- Removing takes effect at once. Deleting the dog removes its rules. The phone shows the same list.

## Words on the cards

Same strings on the desktop and the phone. No new colours: the existing primary, quiet and text-button styles.

- Desktop (`PendingApproval.tsx`), one row: **Allow once** (primary) · **Don't allow** (quiet) · **Always allow** (text button), then the existing "What this covers ›".
- Phone (`Cards.tsx`): **Allow once** | **Don't allow**; under it, centred, **Always allow** with ⓘ for the same line. Send cards keep "Send" and "Don't send", with no Always.
- Where Always is not offered, its place holds one quiet line (table above).

"What this covers" lines:

| Kind | Line |
|---|---|
| Tool | Always allow lets {name} do exactly this again without asking, in any of its chats. |
| Web | Always allow lets {name} fetch or search exactly this again without asking. |
| File | Always allow lets {name} make exactly this change to {file} again, only while the file is as it is now. |
| Teammate | Always allow lets {name} start work with {other} without asking you, while {other} asks you at least as often as {name} does. |

- Answered card: "Always allowed". Settings: title "Always allowed"; row button "Remove"; old grants "No longer used"; empty "Nothing yet. Tap Always allow on a card and it shows here."; paused "Paused" and "Resume".
- Wire: the card gains `lasting?: { offered: true; reach: string } | { offered: false; why: "always-asks" | "command" | "folder-server" | "secret" | "file" | "owner-only" }`. The answer is `decideRequest` with `scope: "always"`; older apps that send only allow or deny keep working.

## Ruled out for now: the pinned command (J4's other choice)

If Jacob wants Always on shell commands, this is the least bad form, and it needs its own attack review:
- **The real folder, per engine.** Claude: every shell request carries the launch folder (`server/drivers/claude.ts:1375`, `:1493`) and the shell keeps a `cd`; the home must set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` and a test must prove a `cd` does not carry to the next command. Codex: each approval carries its own `cwd` (`server/drivers/codex.ts:1154`). Any other engine: no Always. A command whose text changes its folder or repository (`cd`, `pushd`, `-C`, `--git-dir`, `--work-tree`, `GIT_DIR=`, `GIT_WORK_TREE=`) gets none.
- **Pins recorded at grant and compared before answering:** the program file as the home's fixed `PATH` finds it; sha256 of the engine's shell start files (finding 5); each argument that names a path, by real path, link-ness and content hash (finding 4); inside a git work tree, the git dir, HEAD, a clean status, the hooks folder holding only samples, the local config holding only a short allow list of keys, and the remote URLs (finding 2's allow list).
- **What it still cannot see:** installed code in ignored folders (`node_modules`), global configs, the environment, and the network. A changed pin asks again, so `pnpm test` while the dog edits asks after every edit.

## Attacked once by me, with review 1's probes

| What is stored | Hostile input (review 1's case) | Revision 2 |
|---|---|---|
| Shell command | `cd evil && git status` with `core.fsmonitor` (1) | No Always on shell commands |
| Shell command | `credential.helper`, `uploadpack`, `filter.*.clean`, `gpg.program`, `pre-commit`, `alias.*`, changed remote (2) | No Always on shell commands |
| File grant + script | Always on `clean.sh`, Always on `bash ./clean.sh`, then `rm -rf` outside in the file (3) | C1 is gone; the file key pins the content before, so a second change asks; and `bash ./clean.sh` has no Always |
| Shell command | `cat notes.txt` after a link swap; `git push` after a remote change (4) | No Always on shell commands |
| File | Same path, swapped for a link to `~/.zshrc` | Asks: the real path at request time is a link |
| File | Same edit, file changed since | Asks: the content hash before differs |
| File | Hard link to a file outside | Asks: the real path leaves the dog's folders, or the link count is over one |
| Start files | `git()` function in the shell start file (5) | Nothing lasting runs a shell command |
| Store | The dog's shell writes `lasting-allows.json` (6) | It can (proven on a cloud home): a limit, stated below, not opened by this design |
| Old keys | Outside-delete key, `connector:<app>` (7) | `alwaysAsks` runs first; J2 retires the delete key |
| Teammate | Ask-key used to hand work to a Full teammate (8) | One key, compared with the teammate-started mode |
| Guest | Shared desktop workspace member's turn (9) | Owner or admin at the root of the turn, on every home |
| Store | `curl -u admin:…`, `PGPASSWORD=…` (10) | Shell commands get no Always; tool inputs are stored as hashes |
| Tool | MCP server replaced, same name | Asks: the launch line's hash is in the key |
| Tool | A server defined in the dog's folder | No Always |
| Tool | Same input to a person-set server | Allowed: the person read this input; the server is theirs |
| Web | Same URL fetched again | Allowed: nothing new leaves |
| Teammate | A dog-made dog | Inherits nothing |
| Store | A client posts its own key | Refused: the key comes from the home's copy |

## Limits, stated plainly

- **A dog's shell can write the home's data** on a cloud home (finding 6: `/data/.laterdog`, `bots.json`, the new store, owned by the dog's user). So a dog that runs code can grant itself anything, today as before. Closing that needs dogs to run as a separate user from the home, which is not this item.
- **Check, then use** (finding 12): between the home's answer and the engine's action, a process already running can change a file. Nothing in this design starts such a process.
- **A file change granted lastingly can still change what a later command does.** That later command has no Always and shows its own card.

## What the build will touch

- New: `server/laterdog/lasting-allows.ts` and tests, `shared/lasting-allows.ts`.
- Edits: `request.opened` and the always-allow route in `server/index.ts`; `server/permission-proxy.ts` (stop passing suggestions); `server/laterdog/connector-ask.ts` and `owner-auto-request.ts` (`alwaysAsks` before the old keys, with 207's owner); `src/components/PendingApproval.tsx`; `en.json`; the dog settings list. Phone: `Cards.tsx` and the list.
- None of the files ROUND4 reserves. `server/drivers/claude.ts` only if `allowSession` is removed there (one line, outside the compaction window).

## What only a real home or phone can prove

- An Always on a tool call given in one chat holds in another chat of the same dog after a real restart.
- The phone shows the card, stores the grant and lists it.
- A real engine's Edit input matches what the home hashes as the change.

## Answer to review 1

| # | Finding | Answer | Where it changed |
|---|---|---|---|
| 1 | The key's folder is the engine's start folder | Accepted. Closed by removal: shell commands get no Always. The per-engine way the home could know the real folder is written down for J4's other choice. | J4; "No Always"; "Ruled out for now" |
| 2 | The git check is a name list with a name trigger | Accepted. No git check is needed: no shell command lasts. Relay's allow list is kept as a prerequisite of the pinned option. | "Ruled out for now" |
| 3 | C1 plus a script runs anything | Accepted. C1 is dropped; a file key pins the content before, and scripts have no Always. | Closed list removed; file key |
| 4 | The key does not pin what arguments point at | Accepted. No shell Always; argument pins are part of the pinned option. | J4; "Ruled out for now" |
| 5 | Start files can be changed by the dog | Accepted as a reason for J4; the start-file hash is in the pinned option. | Attack table; "Ruled out for now" |
| 6 | A dog can write the home's data | Accepted as a stated limit. | "Limits" |
| 7 | Old keys pass two of the five | Accepted: `alwaysAsks` before both old keys; J2 retires the delete key. | Order of checks; J1; J2 |
| 8 | Asking and handing work are one path | Accepted: one `start-turn` key, compared with the teammate-started mode. | Key table; card line |
| 9 | Guest-driven is only known on a cloud home | Accepted: owner or admin at the root of the turn, on every home. | "No Always" |
| 10 | The secret check misses forms, and text is stored | Accepted: hashes and a redacted preview only; shell text is never stored because shell has no Always. | Store |
| 11 | Edit's new content is not in the request | Accepted: real path + content before + input hash. | Key table |
| 12 | Check, then use | Accepted as a stated limit. | "Limits" |
| 13 | `exec` and `run_on_computer` never ask | Accepted: removed from the design; no Always if they ever ask. | Order of checks; "No Always" |

Review 1's "Design rows that the code contradicts": revision 1's rows 192, 197, 210, 217 and 129 are gone with the shell grants; 210 is now the stated limit, and 217 holds once finding 7's order is built.
