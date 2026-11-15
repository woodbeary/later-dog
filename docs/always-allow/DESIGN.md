# Always on an approval: design (item 16, stage one, revision 3)

Status: design only, for a third attack review before any product code. Base: `main` 0651657, with item 45 (pull request 207, head 395406d) not merged yet. Revision 3 answers review 2 (Relay, `handoff/round4/item-16-REVIEW-2.md`); the answer to each finding is at the end, after the answer to review 1.

Jacob's rule: "Allow once" always comes with "Always", and a dog never asks again for an approval he already gave. Item 45 adds a second rule: five kinds of action always ask, whatever the approval mode.

## At the top, for Jacob: almost nothing you see would get an Always

Revision 3 turns the rule round. **Nothing gets an Always unless the home can show, from fields it holds, that the whole effect is in the request.** Two reviews broke every "everything except these names" rule; a rule that starts from "no" gives a new tool or engine no Always by default.

What passes those tests is small: a search with the same words, and the same input to a tool of a server that runs off your machines (a remote server you set up by its address). On My Cloud in Ask, Auto and Full you see neither as a card today, because your own dogs run in owner-auto there (table below).

**J0 (new, first). What item 16 delivers, against your rule.**
- What it delivers for you: 207's promise holds for every old grant (the order fix, finding 7); the engine no longer widens a chat by itself ("Allow for this chat" goes, `server/permission-proxy.ts:169`); one list, Always allowed, where you see and remove every grant a dog holds, old and new; and the old grants that leak (J2) stop answering.
- What it does not deliver: an Always button on the cards you actually see. Your rule "Allow once always comes with Always" holds only on the few cards the tests allow.
- Recommended: build the fixes and the list, and offer Always only where the tests pass. Every other card shows Allow once, Don't allow, and one quiet line saying why.
- The other choice: keep the Always button off everywhere and build only the fixes and the list. Smaller to build; your rule then holds nowhere.

## The allow rule, as tests on the request

The home answers with an Always offer only when **every** test passes. Each test reads a field the home holds; none reads a tool's name except T6, which is a list of allowed engine tools, so a tool missing from it gets no Always.

| Test | Passes when | Field it reads | Fails for (examples) |
|---|---|---|---|
| T1. Not one of the five | 207's `alwaysAsks` returns nothing | the request as 207 reads it | a push past the checks, a cloud key, an outside delete, a send, a payment |
| T2. Owner at the root | The root of the turn is the owner or an admin (R7: the person whose message started the chain, or a routine's writer) | the turn's root, recorded when the chain starts | a guest, a shared-workspace member, a turn a routine's incoming email started for someone else |
| T3. Whole input carried | The driver set `input` to the tool's whole input, and did not set `argsDigest` or `argsUnknown` | `input`, `argsDigest`, `argsUnknown` on `request.opened` | every Codex request today (no `input`, `server/drivers/codex.ts:1146-1160`) |
| T4. Server is a field | The driver set the server's name as a field (for Claude, the `mcp__<server>__` prefix, parsed by the driver) | a new `server` field | a Codex MCP call (server only in the summary text), an unknown tool name |
| T5. Runs off every machine | The server's spec, as the person configured it, is a remote address (`url`), not a command started on the home, a computer or a Mac | the person's configured spec, before later.dog wraps it | a file, database or command server started as a process; later.dog's `computer`, `browser` and `agents` servers; `shared_computer`; every `local-computer` card |
| T6. Or an allowed engine tool | Instead of T4 and T5: the tool is on a fixed allow list of engine tools whose effect is their input. Today the list holds one: `WebSearch` | the tool name | shell, file edits, `WebFetch` (R12), anything new |
| T7. No secret in the input | `redactSecretsInText` leaves the canonical input unchanged | the canonical input | an input holding a password or key the check can see |
| T8. Not a teammate's turn | The request does not start another dog's turn (R4) | the request kind | `ask_bot`, `delegate_bot` |

Two consequences, stated plainly:
- **Codex dogs get no Always on anything** until the Codex driver sends each request's whole input and its server as fields (R3).
- **A file change gets no Always.** It acts on the file as it is when it runs; pinning the file before (revision 2) made the key correct but meant the same change on the same file almost never comes again, so the button would promise nothing.

### The key, for what passes

| Request | Key |
|---|---|
| A tool of a remote server | Dog id + server name + sha256 of the person's configured spec before wrapping (`url`, headers, nothing per chat; R6) + tool name + sha256 of the input as canonical JSON |
| WebSearch | Dog id + tool + sha256 of the canonical input |

- Nothing is normalised. The dog's id is in the key; a dog-made dog inherits nothing.
- Stored as a hash and a preview that shows the tool and the server's host only, never input values (R11).
- The server's own code and data are not pinned: a remote server answers what it answers. The same input to the same address is the thing the person approved.

## Cards that offer Always, against the cards Jacob sees today

| Card | Offers Always under revision 3 | Seen by Jacob on My Cloud in Ask or Auto | in Full |
|---|---|---|---|
| Item 45's five kinds (push past checks, cloud key, outside delete, send, pay) | No | Yes | Yes |
| A shell command | No | No (owner-auto answers it; `server/laterdog/auto-review.ts:11`, `owner-auto.ts:28`) | No (no request) |
| A file write or edit | No | No (owner-auto) | No |
| A screen, browser or Mac action (`local-computer`, `computer`, `browser`, `shared_computer`) | No | Mac cards: yes, through the Mac's own access setting | Mac cards: yes |
| A tool of a server started on the machine | No | No (owner-auto) | No |
| A tool of a remote server | **Yes** | No (owner-auto) | No |
| WebSearch | **Yes** | No (auto answers it; `autoVerdict` web-search) | No |
| WebFetch | No | No (owner-auto) | No |
| Starting a teammate's turn | No | No (`peerReviewRequired` is false for the owner's own work, `server/index.ts:3886`) | No |
| A question from a dog | Not an approval | Yes | Yes |

Where an Always card does appear: with Auto-review on (the reviewer holds a remote tool or a search), in Custom mode, and on a shared workspace or a guest's turn (R9, R10).

## For Jacob to decide (each with a recommendation)

**J0.** Above.

**J4. Anything that acts where the home cannot see the state gets no Always.** This is revision 2's "no shell Always", widened as review 2 asked: shell, file edits, screen, browser, Mac, servers that run on a machine, web fetches. Recommended: accept. The other choice (a pinned Always for shell commands) stays written down below, ruled out for now.

**J1. Item 45's five kinds never offer Always.** Recommended: accept. True in code only once `alwaysAsks` runs before the old keys. The cost: each lane's push from its home clone with the checks off shows a card every time; lanes can push from their cloud computer, where the checks run.

**J2. Grants you already gave.** Main stores five kinds of lasting grant that answer without a card:
- delete outside its folders, everywhere (`DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY`);
- use this app without asking (`connector:<app>`);
- saved exact shell commands (`command-allowlist.json`);
- the Mac's Always, which sets that Mac to "always" for every dog and then allows `run_command`, `write_file`, `delete_file` and screen actions with no card (`server/mac-approval.ts:203-210`, `:228`; R5);
- the teammate keys (`ask_bot`, `delegate_bot` on a chat's `alwaysAllow`).

Recommended: stop answering from the outside-delete key, saved shell commands and the teammate keys; answer from `connector:<app>` only for calls `alwaysAsks` does not match; and make the Mac's Always no longer cover commands, writes, deletes or screen actions (it keeps covering reads). All of them stay in the Always allowed list, marked "No longer used" where they stopped, with Remove. The other choice: keep honouring them, knowing they answer things the tests above refuse.

**J3. An Always holds in every chat of that dog.** The remaining keys name everything that differs (the server's configured spec, the tool, the input). Recommended: yes. The other choice: per chat.

## Designs: who owns the key

- **A. The engine (ruled out):** its rules widen by shape, live where the dog can edit them, and differ by engine.
- **B. A key from the request's shape (ruled out):** the abandoned `fable/always-allow`; four rounds found a family member that ran or revealed something unseen.
- **C. The person's device (ruled out):** dogs work while devices sleep, devices disagree, a guest's device would hold the owner's grants.
- **D. The home, keyed by exactly the thing approved, offered only when the tests pass (chosen).**
- **E. The home with pins on everything a shell command depends on (ruled out for now):** see below.

## Where the check runs, and its order

When a request opens (`request.opened`), the first that applies decides:
1. 207's `alwaysAsks` shows its card. It runs before every stored grant, the old ones included: in `connectorSendDecision` before the always-allow and this-turn lines, in `settleOwnerAutoPermission` before `ownerAllows`, and in the Mac approval before its "always" mode.
2. The owner guard's hard refusals refuse.
3. **New: the lasting-allow lookup**, only for requests that pass T1 to T8. On a match the home answers allow and logs source `lasting-allow` with the rule id.
4. Everything as today.

- Every answer to an engine is allow-once: `updatedPermissions` is no longer passed on, "Allow for this chat" is removed, and an older app's `always: true` becomes allow once (R8, with a test).
- After the emergency downgrade, lasting allows are paused, not deleted. An ordinary mode change leaves them.

## What is stored and where

- `server/laterdog/lasting-allows.ts` writes `lasting-allows.json` in the home's data folder (mode 600, atomic writes, the same checks as `command-allowlist.json`).
- Each rule: `{ version: 3, id, botId, kind: "remote-tool"|"search", keySha256, preview, grantedAt, grantedBy, fromThreadId }`. `preview` is the tool and the server's host, or "Search".
- At most 500 rules per dog. An unreadable file matches nothing.
- The grant route, `POST /api/bots/:id/always-allow`, takes the pending request's id and finds the card by bot, thread and request id, unanswered and not dismissed. It checks owner or admin of the turn's root itself, not `cardAnswerRefusal` (which lets a thread's starter answer; R8). It recomputes T1 to T8 from the home's copy and refuses with 409 if any fails.

## How a person lists and removes them

Dog settings, section **Always allowed**: every rule and every old grant (J2), newest first, each with what, where, when and **Remove**; old grants that stopped show "No longer used". Removing takes effect at once; deleting the dog removes its rules. The phone shows the same list.

## Words on the cards

Same strings on the desktop and the phone; no new colours.

- Desktop (`PendingApproval.tsx`): **Allow once** (primary) · **Don't allow** (quiet) · **Always allow** (text button), then "What this covers ›".
- Phone (`Cards.tsx`): **Allow once** | **Don't allow**; under it, centred, **Always allow** with ⓘ. Send cards keep "Send" and "Don't send".
- Where Always is not offered, its place holds one quiet line. If several tests fail, the first line in this order wins:

| Order | Failed test | Line |
|---|---|---|
| 1 | T1 | This one always asks. |
| 2 | T2 | Only the owner can choose Always. |
| 3 | T7 | This one asks each time: it holds a password or key. |
| 4 | T8 | This one asks each time: a teammate can reach things this dog cannot. |
| 5 | T3 or T4 | This one asks each time: later.dog cannot see all of what it does. |
| 6 | T5 or T6, screen, browser, computer or Mac | This one asks each time: it acts on what is on the screen then. |
| 7 | T5 or T6, anything else | This one asks each time: it acts on things as they are then. |

"What this covers" lines:

| Kind | Line |
|---|---|
| Remote tool | Always allow lets {name} do exactly this again with {host} without asking, in any of its chats. |
| Search | Always allow lets {name} search for exactly this again without asking. |

Answered card: "Always allowed". Settings: "Always allowed", "Remove", "No longer used", "Paused", "Resume", empty "Nothing yet. Tap Always allow on a card and it shows here."

Wire: `lasting?: { offered: true; reach: string } | { offered: false; why: "always-asks" | "owner-only" | "secret" | "teammate" | "incomplete" | "screen" | "state" }`.

## Ruled out for now: the pinned command (J4's other choice)

Kept from revision 2. The real folder per engine (Claude needs `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` and a test that a `cd` does not carry; Codex sends its own `cwd`; others none), plus pins on the program file, the shell start files, each path argument, and inside git the git dir, HEAD, a clean status, sample-only hooks, an allow-listed local config and the remote URLs. It still cannot see installed packages, global configs, the environment or the network, and asks again after any change.

## Attacked once by me, with review 2's hands probe

| Case (review 2) | Test that refuses it |
|---|---|
| `key_press {"keys":"cmd+enter"}`, `click {"x":640,"y":412}`, `type_text {"text":"y\n"}` on the local computer (R1) | T5: the `computer` server is started on the machine; also its card is `local-computer` |
| The Mac's `computer_call`, `run_command`, `write_file`, `delete_file` | T5 (`shared_computer` runs on a Mac); J2 removes the Mac Always's cover |
| `open_url`, `screenshot` | T5 |
| `read_file {"path":".../notes.txt"}` after a link swap (R2) | T5: a file server started as a process |
| `query {"sql":"select …"}` on a local database server | T5 |
| `execute_command {"command":"pnpm test"}` on a command server | T5 |
| A Codex MCP call `search_issues` with input A, then B (R3) | T3: Codex sends no input |
| A Codex file change | T3, and file changes have no Always |
| A teammate turn, B has Gmail and A does not (R4) | T8 |
| `WebFetch` to a name that later resolves to 127.0.0.1 (R12) | T6: WebFetch is not on the list |
| A remote server's address changed in settings | Asks: the configured spec's hash is in the key |
| The same remote tool and input, a new chat (R6) | Allowed: the key holds no per-chat value |
| A remote tool whose input holds a missed secret (R11) | The same secret to the same address; the list shows only the tool and host |
| An older app answers with `always: true` (R8) | Allow once |
| A thread's starter who is not the owner posts a grant (R8) | Refused: owner or admin of the root |
| A new engine tool or a new engine | No Always: it fails T3, T4 or T6 by default |

## Limits, stated plainly

- **A dog's shell can write the home's data** on a cloud home, so a dog that runs code can grant itself anything, today as before. Closing it needs dogs to run as a separate user from the home.
- **Check, then use:** between the home's answer and the engine's action, a process already running can change things. Nothing in this design starts one.
- **Files the engine loads with no request** (R13): Claude reads `.claude/settings.json` with its hooks and loads `.mcp.json` servers from the dog's folder (`server/drivers/claude.ts:1269`, `:1314-1318`). A file write is never lasting under revision 3, so no Always replays one; each write asks, and the card shows the file.
- **A remote server answers what it answers:** the key pins the address and the input, not the server's data.

## What the build will touch

- New: `server/laterdog/lasting-allows.ts` (the tests T1 to T8 as one function, and the store) with tests, `shared/lasting-allows.ts`.
- Edits: the `request.opened` path and the always-allow route in `server/index.ts`; `server/permission-proxy.ts`; `connector-ask.ts`, `owner-auto-request.ts` and `mac-approval.ts` (`alwaysAsks` before the old grants); the Claude driver adds `server` to `request.opened` (one field); `PendingApproval.tsx`; `en.json`; the dog settings list. Phone: `Cards.tsx` and the list.
- None of the files ROUND4 reserves; the Claude driver change sits outside the compaction window.

## What only a real home or phone can prove

- A remote tool's Always holds in another chat of the same dog after a real restart.
- The phone shows the card, stores the grant and lists it.
- Which cards Jacob really sees in a week of use (the table above is read from code).

## Answer to review 2

| # | Finding | Answer | Where it changed |
|---|---|---|---|
| R1 | Screen tools get an Always | Accepted: T5 refuses every server started on a machine, which covers `computer`, `browser`, `shared_computer` and every `local-computer` card, without naming them | Allow rule; attack table |
| R2 | Local-process servers read or run what is there | Accepted: T5, only remote servers by address | Allow rule |
| R3 | Codex requests carry no input | Accepted: T3 and T4; Codex dogs get no Always until the driver sends whole inputs and the server | Allow rule; consequences |
| R4 | The teammate key compares modes, not reach | Accepted, simplest fix: no lasting Always for starting a teammate's turn (T8). Jacob loses nothing he sees on his own dogs (`peerReviewRequired` is off for the owner's own work); old teammate keys move to J2 | T8; J2 |
| R5 | The Mac's Always is an old wide grant | Accepted: in J2, recommended to stop covering commands, writes, deletes and screen actions; `alwaysAsks` before it | J2; order |
| R6 | The launch line holds per-chat values | Accepted: the key hashes the person's configured spec before wrapping; remote servers are keyed by it | Key table |
| R7 | The root of a turn is undefined off a cloud home | Accepted: the person whose message started the chain, or a routine's writer; nothing else counts as the owner | T2 |
| R8 | The grant route | Accepted: its own owner-or-admin check on the root, match by bot, thread and request id, and `always: true` becomes allow once, with a test | Store; order |
| R9 | The J4 claim | Confirmed, and used for the size table | Size table |
| R10 | Where Jacob gets more cards | Accepted and listed under the size table | Size table |
| R11 | A missed secret can show in the list | Accepted: the preview shows the tool and host only | Key; store |
| R12 | A fetch's destination is decided when it runs | Accepted: the engine does the fetch, so the home cannot check it at each use; WebFetch gets no Always | T6 |
| R13 | One link; the limit about loaded files | Accepted: file changes get no Always at all, which closes both; the limit is reworded | Allow rule; limits |

## Answer to review 1

Revision 2's answers stand: findings 1 to 5 are closed by giving shell commands no Always (J4); 6 and 12 are stated limits; 7 is the order fix, now also before the Mac's Always; 8 is replaced by T8; 9 is T2 with R7's root; 10 and 11 are closed (hashes; no file Always); 13 is closed (no Always for `exec` or `run_on_computer`, both fail T5).
