# Always on an approval: design (item 16, stage one, revision 5)

Status: design only, ready for code once this revision is checked. Base: `main` 0651657, with item 45 (pull request 207, head 395406d) not merged yet. Revision 5 answers review 4 (Relay, `handoff/round4/item-16-REVIEW-4.md`): the allow rule is unchanged; the build order gains the steps that turn off three lasting answers main already has, and the home gets the whole input of a search. The answers to reviews 1 to 4 are at the end.

Jacob's rule: "Allow once" always comes with "Always", and a dog never asks again for an approval he already gave. Item 45 adds a second rule: five kinds of action always ask, whatever the approval mode.

## At the top, for Jacob: one card offers Always

Revision 4 removes rather than patches. Review 3 showed that "a remote server by its address" is not "the whole effect is in the request": a hosted browser clicks whatever page is open, a sandbox runs against what it holds, and a send or a payment 207 does not know by name would repeat with no card. Every proposed patch (trusting a server's own "read-only" mark, checking that an address is public) reads a field the other side sets, and a server can be one a dog proposed. So a tool of any server gets no Always.

**What is left: the same web search with the same words.** Nothing else offers Always. On My Cloud in Ask, Auto and Full you see no search card today, because your own dogs run in owner-auto there and auto answers searches.

**J0. What item 16 delivers, against your rule. Three choices; this is yours to decide.**
- **(a) Recommended: build the fixes and the list, with Always only on the same search.** You get: 207's promise holds over every old grant (the order fix); the engine no longer widens a chat by itself ("Allow for this chat" goes); the old grants that leak stop answering (J2, your choice per grant); one list, Always allowed, where you see and remove every grant a dog holds. The allow rule stays in code as the one door: a later kind gets Always only by passing its tests and its own attack review.
- **(b) No Always button anywhere:** the fixes and the list only. Smallest to build; your rule then holds nowhere.
- **(c) A wider Always:** read-only tools of remote servers, or a pinned shell command. Both are written down under "Ruled out for now" with what each would need and what each still cannot see.

## The allow rule, as tests on the request

One function, the only door to an Always. Every test must pass; the first that fails decides the card's line.

| Test | Passes when | Field it reads | Fails for (examples) |
|---|---|---|---|
| A1. Not one of the five | 207's `alwaysAsks` returns nothing | the request as 207 reads it | a push past the checks, a cloud key, an outside delete, a send, a payment |
| A2. Only the owner reached this turn | Worked out when the request opens, from the thread's own messages since the turn began, as 207 does (`server/index.ts:1536`): every person message is from the owner or an admin, no message is from another dog, and a routine's run counts as its writer's (G4) | the thread's messages since the turn began | a guest's turn; a guest's message queued before the turn and delivered during it; a shared-workspace member; another dog's message |
| A3. Whole input carried | The driver set the new `wholeInput` field to the tool's whole input object, the same object the engine runs (G2) | `wholeInput` on `request.opened` | every request whose driver does not set it: every non-Claude engine today, and a Claude request missing it |
| A4. On the allow list | The pair (driver, tool) is on a fixed list of engine tools whose whole effect is their input. The list holds one pair: (Claude, `WebSearch`) (G3) | the driver kind and the tool name | every tool of every server (later.dog's own, the person's, local or remote), shell, file edits, `WebFetch`, screen and Mac actions, starting a teammate's turn, another driver's tool titled "WebSearch", anything new |
| A5. No secret in the input | `redactSecretsInText` leaves the canonical input unchanged | the canonical input | a query holding a password or key the check can see |

A new tool or engine fails A4 by default. A kind joins the list only with its own tests and attack review.

### The key

Dog id + `claude` + `WebSearch` + sha256 of `wholeInput` with keys sorted (S7, G2). For Claude, `wholeInput` is `ask.input`, the object the permission proxy returns as `updatedInput` (`server/permission-proxy.ts:168`); today the driver sends only `askedFields(ask.input)` (`server/drivers/claude.ts:469-478`, `:1491`), which drops `query`, `allowed_domains` and `blocked_domains`, so step 6 adds the field. Nothing is normalised: one character different is another search, and it asks. The preview stored and shown is "Search", never the words.

## Cards and Always, against the cards Jacob sees today

| Card | Offers Always under revision 4 | Seen by Jacob on My Cloud in Ask or Auto | in Full |
|---|---|---|---|
| Item 45's five kinds | No | Yes | Yes |
| A shell command | No | No (owner-auto) | No (no request) |
| A file write or edit | No | No | No |
| A screen, browser or Mac action | No | Mac cards: yes | Mac cards: yes |
| A tool of any server, local or remote | No | No (owner-auto) | No |
| WebFetch | No | No | No |
| **WebSearch** | **Yes** | No (auto answers it) | No |
| Starting a teammate's turn | No | No (`peerReviewRequired` is off for the owner's work, `server/index.ts:3886`) | No |
| A question | Not an approval | Yes | Yes |

A search card appears with Auto-review on, in Custom mode, or on a shared workspace or a guest's turn.

## For Jacob to decide (each with a recommendation)

**J0.** Above.

**J4. Anything whose effect depends on state the home cannot see gets no Always**: shell, file edits, screen, browser, Mac, every server's tools, web fetches. Recommended: accept.

**J1. Item 45's five kinds never offer Always.** Recommended: accept. With A4 it holds by construction, whatever 207 knows by name; in code it also needs the order fix before the old grants. The cost: each lane's push from its home clone with the checks off shows a card every time.

**J2. Grants you already gave (restated after review 4).** Main has five lasting answers besides the engine's own. Two are settled by J1 itself; three are your choice, each its own commit, landed only if you choose it.

Settled by the order fix (step 1), which any build lands first:
- **The outside-delete key.** Every delete outside a dog's folders is one of 207's five kinds, so once `alwaysAsks` runs before the key, the key answers nothing. "Keep" is not possible under J1. What you would notice: a dog holding it shows a card for each outside delete, also in owner-auto (`server/laterdog/owner-auto-request.ts:33`, `:46`).
- **An app's "Always allow" (`connector:<app>`) for sends.** Every send is one of the five, so the key stops answering sends; it keeps answering the app's other calls. What you would notice: that app's sends ask each time on My Cloud (`server/laterdog/connector-ask.ts:52-54`).

Your choice, each with what stays open if you keep it:
- **J2-a. Saved exact shell commands** (`command-allowlist.json`, desktop only; your cloud home has none). Recommended: stop. If kept, review 1's findings 1 and 4 stay open for them: on Claude the saved folder is the engine's start folder, not where the shell has gone, and nothing pins what the arguments point at. What you would notice if stopped: those commands ask where cards appear (Auto-review, Custom, a shared workspace).
- **J2-b. Teammate keys** (`ask_bot`, `delegate_bot`). Recommended: stop. If kept, review 2's R4 stays open: a dog holding the key sends any words to a teammate that can read things it cannot, such as mail. What you would notice if stopped: no change for your own work (`peerReviewRequired` is off there).
- **J2-c. The Mac's Always.** Recommended: it covers reads only. If kept as it is, every dog's command, write, delete and screen action on that Mac runs with no card (`server/mac-approval.ts:228`), which J4 refuses for everything else. What you would notice if changed: each such action asks again, at most one card per kind, per message, per dog; looking at files keeps working.

Not a choice: **the engine's own "Allow for this chat"** goes (step 3), on every engine, because the engine decides how wide it is (design A). You notice it only where cards appear.

**J3. An Always holds in every chat of that dog.** The key holds no per-chat value. Recommended: yes.

## Where the check runs, and its order

When a request opens (`request.opened`), the first that applies decides:
1. 207's `alwaysAsks` shows its card, before every stored grant, the old ones included: in `connectorSendDecision` before the always-allow and this-turn lines, in `settleOwnerAutoPermission` before `ownerAllows`, and in the Mac approval before its "always" mode.
2. The owner guard's hard refusals refuse.
3. **New: the lasting-allow lookup.** It runs A1 to A5 on every request, not only at the grant (G7); only a request that passes all five is looked up. On a match the home answers allow and logs source `lasting-allow` with the rule id.
4. Everything as today.

- Every answer to every engine is allow-once: the home sends `always: false` in its one answer path (`server/index.ts:5369`), the Claude proxy passes no `updatedPermissions`, ACP picks the allow-once option and no longer remembers an operation for the chat (`server/drivers/acp/core.ts:907`, `:967-972`), and no card carries `allowSession` (`server/index.ts:7305`, `server/drivers/claude.ts:1496`, `acp/core.ts:1010`) (G1c).
- Cards stop carrying old keys: the send card and the outside-delete card carry no `allowKey`; with J2-a no card carries `commandAllowlist`; with J2-b the teammate card carries no `allowKey`; with J2-c the Mac card offers Always only on reads. The route refuses every key it no longer honours with 409 (S6, G1).
- After the emergency stop, lasting allows are paused, not deleted; today the stop clears only a Full or Custom chat's keys (`server/index.ts:9613-9620`), so the pause is added in step 6 (G5).

## What is stored and where

- `server/laterdog/lasting-allows.ts` writes `lasting-allows.json` in the home's data folder (mode 600, atomic writes, the same checks as `command-allowlist.json`).
- Each rule: `{ version: 4, id, botId, kind: "search", keySha256, preview: "Search", grantedAt, grantedBy, fromThreadId }`. At most 500 rules per dog. An unreadable file matches nothing.
- The grant route, `POST /api/bots/:id/always-allow`, takes the pending request's id, finds the card by bot, thread and request id, unanswered and not dismissed, checks owner or admin of the turn itself (not `cardAnswerRefusal`), recomputes A1 to A5 from the home's own copy, and refuses with 409 if any fails.

## How a person lists and removes them

Dog settings, section **Always allowed**: every rule and every old grant (J2), newest first, each with what, where, when and **Remove**; old grants that stopped show "No longer used". Removing takes effect at once; deleting the dog removes its rules. The phone shows the same list.

## Words on the cards

Same strings on the desktop and the phone; no new colours.

- Desktop (`PendingApproval.tsx`): **Allow once** (primary) · **Don't allow** (quiet) · **Always allow** (text button) where offered, then "What this covers ›".
- Phone (`Cards.tsx`): **Allow once** | **Don't allow**; under it, centred, **Always allow** with ⓘ where offered. Send cards keep "Send" and "Don't send".
- Where Always is not offered, its place holds one quiet line. The first failed test's line wins:

| Order | Failed test | Line |
|---|---|---|
| 1 | A1 | This one always asks. |
| 2 | A2 | Only the owner can choose Always. |
| 3 | A5 | This one asks each time: it holds a password or key. |
| 4 | A3 | This one asks each time: later.dog cannot see all of what it does. |
| 5 | A4, a screen, browser, computer or Mac action | This one asks each time: it acts on what is on the screen then. |
| 6 | A4, starting a teammate's turn | This one asks each time: a teammate can reach things this dog cannot. |
| 7 | A4, anything else | This one asks each time: it acts on things as they are then. |

"What this covers", search: "Always allow lets {name} search for exactly this again without asking, in any of its chats."

Answered card: "Always allowed". Settings: "Always allowed", "Remove", "No longer used", "Paused", "Resume", empty "Nothing yet. Tap Always allow on a card and it shows here."

Wire: `lasting?: { offered: true; reach: string } | { offered: false; why: "always-asks" | "owner-only" | "secret" | "incomplete" | "screen" | "teammate" | "state" }`.

## Ruled out for now (J0's choice c)

**c1. Read-only tools of remote servers.** What it would need, all at once:
- the server's own `tools/list`, fetched with the person's spec at grant and at each answer, marking the tool `readOnlyHint: true`;
- an `https` address whose host is a name (not an IP, `localhost`, `*.local` or `*.internal`) resolving only to public addresses at grant and at each answer;
- the spec the driver actually mounted for that thread, a launch with `--strict-mcp-config`, and server names without `__` (S3);
- the signed-in account in the key, or signing in again removing the grants (S5).

What it still cannot see: whether the server's read-only mark is true (a server a dog proposed can mark anything read-only, and the person turning it on sees only an address), a public name that tunnels to this machine, and data that changes between reads.

**c2. The pinned shell command.** The real folder per engine (Claude needs `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` and a test that a `cd` does not carry; Codex sends its own `cwd`; others none), plus pins on the program file, the shell start files, each path argument, and inside git the git dir, HEAD, a clean status, sample-only hooks, an allow-listed local config and the remote URLs. It still cannot see installed packages, global configs, the environment or the network, and asks again after any change.

## Notes for item 45 or later, on main as it is (no design here)

- **Local addresses for remote servers** (S2): later.dog accepts any `http` or `https` host for a server (`server/mcp-http.ts:44-53`), and a dog can propose one through `add_mcp_server`. It no longer matters for Always; it matters for what a person turns on.
- **Server names with `__`, and launches without `--strict-mcp-config`** (S3): the name the home sees may not be the server the engine called. It no longer matters for Always.
- **Sign-in tokens are not in a server's spec** (S5): signing in again as another account keeps the same server. It no longer matters for Always.

## Outside this item: connected-app actions that never ask

Through a connected app, `GMAIL_DELETE_MESSAGE`, `GMAIL_MOVE_TO_TRASH`, `GOOGLEDRIVE_DELETE_FILE`, `GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE`, `GITHUB_ADD_A_REPOSITORY_COLLABORATOR`, `GITHUB_DELETE_A_REPOSITORY` and `NOTION_ARCHIVE_PAGE` run with no card in any mode (`asksAsConnector` is false for them; review 3's `connector-probe.ts`). That is for item 45's owner; no design for it here.

## Build tests

Each takes the attack as its input and runs through the real caller (`request.opened`, `requestPeerApproval`, the Mac approval, the grant route), not only the rule function (G8).

1. `mcp__computer__key_press {"keys":"cmd+enter"}` on a `local-computer` card: no Always, line 5.
2. `mcp__agents__shared_computer {"action":"run_command","command":"ls"}`: no Always.
3. A person-set command server's `read_file {"path":"notes.txt"}`: no Always.
4. A remote server's `browser_click {"selector":"button[type=submit]"}`: no Always, line 7.
5. Remote `mcp__resend__emails_create` and `mcp__bank__wire_funds`: no Always.
6. A server at `http://127.0.0.1:8765/mcp` with `read_file`: no Always.
7. A remote server's `search_issues {"q":"x"}`: no Always.
8. A Codex MCP call with `argsUnknown`, and a Codex file change: no Always, line 4.
9. A Claude Edit or Write: no Always.
10. `WebFetch` of any address: no Always.
11. Through the real Claude event and `request.opened`: `WebSearch` with the same whole input twice is answered from the grant, and the engine gets allow once with no `updatedPermissions`; one character different shows a card; in another chat of the same dog it is answered (G8).
12. A search whose query holds a key the check sees: no Always, line 3.
13. A real room thread, a guest message queued before the owner's turn and delivered during it, then a search: no Always and no answer from a grant (G4).
14. A grant posted by a thread's starter who is not owner or admin: 403. A grant on an answered or dismissed card, or another dog's request id: 409.
15. The route refuses `connector:gmail` and the outside-delete key with 409; send and outside-delete cards carry no `allowKey`.
16. An older app answering `always: true`: through the home's answer path, the Claude proxy and an ACP engine, each gets allow once; on ACP the allow-once option is picked and the same input asks again (G1c, G8).
17. The order: a stored `connector:<app>` key with a send; the outside-delete key in owner-auto; the Mac in "always" mode with a send. Each shows a card.
18. The stored preview is "Search", never the words.
19. Through `requestPeerApproval`: starting a teammate's turn offers no Always, line 6 (with J2-b, see 23).
20. No card carries `allowSession`; an older phone shows no "Allow for this chat" (G1c).
21. A Claude `WebSearch` event carries `wholeInput`; with it missing there is no Always; two searches with the same `query` and different `allowed_domains` get different keys (G2).
22. A Pi request titled "WebSearch" that carries an input gets no Always (G3).
23. With J2-b: through `requestPeerApproval` with a stored `delegate_bot` key, a card shows; the teammate card has no `allowKey`; the route refuses `ask_bot:*` and `delegate_bot:*` with 409.
24. With J2-a: a saved rule for exact text and folder exists; the same request shows a card; no card carries `commandAllowlist`; `POST /api/bots/:id/command-allowlist` returns 409; the rules list as "No longer used".
25. With J2-c: the Mac in "always" mode; `run_command`, `write_file`, `delete_file` and `computer_call` each show a card; `list_files` and `read_file` do not.
26. Another dog's message reaches an owner's turn, then a search: no answer from a grant (G4).
27. After the emergency stop, the search grant is paused and the search asks; after Resume it answers (G5).
28. Deleting a dog removes its search grants; an unreadable store answers nothing and refuses new grants (G7).

## The build order

Each step is one commit with its tests. Main is safe after any step alone: no step adds a lasting answer before the step that checks it, and between step 3 and step 7 cards simply have no lasting choice (a step back only where cards appear today: Auto-review, Custom, a shared workspace). **The smallest set the Mac session can land with none of Jacob's choices made: steps 1, 2 and 3.**

| # | Commit | Files | Tests | Depends on a J choice | Main after it alone |
|---|---|---|---|---|---|
| 1 | The order fix: `alwaysAsks` before the old grants | `server/laterdog/connector-ask.ts`, `owner-auto-request.ts`, `server/mac-approval.ts` | 17 | No (completes J1; can land with 207) | Safe: the outside-delete key and app keys stop answering 207's kinds |
| 2 | Send and outside-delete cards drop their keys; the route refuses them | `server/index.ts` (`:7308`, `:15654`, route `:17652-17674`) | 15 | No | Safe: no new Always offered on those cards |
| 3 | No engine widens a chat: `always: false` to every engine, ACP allow-once, no `allowSession` on any card, no `updatedPermissions` | `server/index.ts` (`:5369`, `:7305`), `server/permission-proxy.ts`, `server/drivers/acp/core.ts`, `server/drivers/claude.ts` (`:1496`, one field, outside the compaction window) | 16, 20 | No | Safe: answers become allow-once; "Allow for this chat" disappears |
| 4 | J2-a: saved commands stop | `server/index.ts` (`:5374-5377`, `:7258`, `:7303`, the command-allowlist route), `src/components/PendingApproval.tsx` (`:203`, `:294`) | 24 | **Yes, J2-a** | Safe: those commands ask |
| 5 | J2-b: teammate keys stop | `server/peer-approval.ts` (`:93-99`, `:128`), the always-allow route | 23 | **Yes, J2-b** | Safe: teammate turns ask where they asked before the key |
| 6 | The allow rule and the store: A1 to A5 as one function (A2 read from the thread's messages), the driver's `wholeInput` field, the store, the grant route, the list endpoint, the lookup in `request.opened`, and the emergency pause | new `server/laterdog/lasting-allows.ts`, `shared/lasting-allows.ts`; `server/drivers/claude.ts` (`:1491`, one field); `shared/runtime-events.ts`; `server/index.ts` (`request.opened`, the route, `:9613-9620`) | 1 to 14, 18, 19, 21, 22, 26, 27, 28 | No | Safe: a search grant is stored and answered in the same commit, so nothing says "Always allowed" without answering |
| 7 | The desktop card and the settings list | `src/components/PendingApproval.tsx`, `en.json`, the dog settings | card rendering of the why lines and "Always allowed" | No | Safe |
| 8 | J2-c: the Mac's Always covers reads only | `server/mac-approval.ts` (`:203-210`, `:228`), the Mac card | 25 | **Yes, J2-c** | Safe: Mac actions other than reads ask |

Phone half (`later-dog-phone`), after step 6 lands (G5): `src/ui/Cards.tsx` uses "Allow once" as the primary label, shows Always only when the card's `lasting.offered` is true, shows the why line otherwise, and no longer reads `allowKey` or `allowSession` for a lasting choice; the settings list reads the new list endpoint with the same words. An older phone against the finished home shows "Allow", no Always on any card, and no "Allow for this chat".

None of the files ROUND4 reserves.

## Limits, stated plainly

- **A dog's shell can write the home's data** on a cloud home, so a dog that runs code can grant itself anything, today as before. Closing it needs dogs to run as a separate user from the home.
- **Check, then use:** between the home's answer and the engine's action, a process already running can change things. A search sends only its words.
- **A search's results change from day to day.** The key pins the words, not the answers.

## What only a real home or phone can prove

- A search's Always holds in another chat of the same dog after a real restart.
- The phone shows the card, stores the grant and lists it.
- Which cards Jacob really sees in a week (the size table is read from code).
- A guest's message reaching a running owner turn (A2) as a real room does it.

## Answer to review 4

| # | Finding | Answer | Where it changed |
|---|---|---|---|
| G1 | Three lasting answers on main survive the build | Accepted: step 3 sends `always: false` to every engine and removes `allowSession` from every card (G1c); steps 4 and 5 stop saved commands and teammate keys if Jacob chooses (G1a, G1b), and J2 says which earlier finding stays open if he keeps either | Order of checks; J2; build steps 3 to 5; tests 16, 20, 23, 24 |
| G2 | The home does not hold a search's whole input | Accepted: the Claude driver adds `wholeInput` (`ask.input`) to `request.opened` in step 6; A3 and the key read only it | A3; the key; test 21 |
| G3 | A4 reads a name some drivers take from free text | Accepted: the list holds the pair (Claude, `WebSearch`) | A4; test 22 |
| G4 | A2's record would have a gap | Accepted: A2 is read from the thread's own messages when the request opens, as 207 does; any non-owner person or other dog fails it; a routine counts as its writer's | A2; tests 13, 26 |
| G5 | The order, the phone and the pause | Accepted: the phone lands after step 6; the emergency pause is in step 6; J2 says the order fix settles two of five | Build order; J2; test 27 |
| G6 | The Mac's reads-only is in no step | Accepted: step 8, after J2-c | Build order; test 25 |
| G7 | The lookup in other states | Accepted: A1 to A5 run on every request; a dog-made or recreated dog has a new id and inherits nothing | Order of checks; test 28 |
| G8 | Tests that pass while the attack works | Accepted: every build test runs through the real caller | Build tests 11, 13, 16, 19, 23 to 25 |

## Answer to review 3

| # | Finding | Answer | Where it changed |
|---|---|---|---|
| S1 | "Remote by address" is not "the whole effect is in the request" | Accepted, closed by removal: no server's tool gets an Always (A4). Relay's T9 (trust the server's read-only mark) is written down under c1, not taken: the mark is set by the other side, and a server can be one a dog proposed. | Top; A4; "Ruled out for now" |
| S2 | A remote address can be this machine | Accepted, closed by removal: with no server tool on the list, the address no longer reaches an Always. The address check stays a note for item 45 or later. | A4; "Notes" |
| S3 | The server's name may not be the server called | Moot for Always (no server tools); kept as a note | "Notes" |
| S4 | The root is weaker than 207's latest-message check | Accepted: A2 also fails if anyone else's message reached the turn | A2; build test 13 |
| S5 | Sign-in tokens are not in the spec | Moot for Always; kept as a note | "Notes" |
| S6 | Cards still carry the old keys | Accepted: the cards drop them, the route refuses them with 409, the Mac's Always only on reads | Order; build step 2; test 15 |
| S7 | Canonical input | Accepted: hash the object `updatedInput` returns, keys sorted | The key |
| S8 | WebSearch is sound | Kept as the one entry on the list | A4 |

## Answer to reviews 1 and 2

- **Review 1:** findings 1 and 4 also stay open for saved commands if Jacob keeps them (J2-a); findings 1 to 5 are closed by giving shell commands no Always (J4); 6 and 12 are stated limits; 7 is the order fix (also before the Mac's Always); 8 is closed (no teammate Always); 9 is A2; 10 and 11 are closed (hashes; no file Always); 13 is closed (`exec` and `run_on_computer` fail A4).
- **Review 2:** R4 also stays open for old teammate keys if Jacob keeps them (J2-b); R1 to R4 are closed by A3 and A4 (no screen, local-server, Codex-without-input or teammate Always); R5 is J2 and the Mac card; R6 is moot (no server keys); R7 is A2 with S4's change; R8 is the route; R9 and R10 are the size table; R11 is the "Search" preview; R12 is closed (no `WebFetch` Always); R13 is closed (no file Always).
