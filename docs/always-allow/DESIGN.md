# Always on an approval: design (item 16, stage one, revision 4)

Status: design only, for a fourth attack review before any product code. Base: `main` 0651657, with item 45 (pull request 207, head 395406d) not merged yet. Revision 4 answers review 3 (Relay, `handoff/round4/item-16-REVIEW-3.md`); the answers to reviews 1 to 3 are at the end.

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
| A2. Only the owner reached this turn | The person whose message started the chain (or the routine's writer) is the owner or an admin, **and** no message from anyone else reached the turn while it ran (S4) | the turn's root and the people whose messages reached it, recorded on the turn | a guest's turn; a guest's message in a room during an owner's turn; a shared-workspace member |
| A3. Whole input carried | The driver set `input` to the tool's whole input, with no `argsDigest` and no `argsUnknown` | `input`, `argsDigest`, `argsUnknown` on `request.opened` | every Codex request today |
| A4. On the allow list | The tool is on a fixed list of engine tools whose whole effect is their input. The list holds one entry: `WebSearch` | the tool name | every tool of every server (later.dog's own, the person's, local or remote), shell, file edits, `WebFetch`, screen and Mac actions, starting a teammate's turn, anything new |
| A5. No secret in the input | `redactSecretsInText` leaves the canonical input unchanged | the canonical input | a query holding a password or key the check can see |

A new tool or engine fails A4 by default. A kind joins the list only with its own tests and attack review.

### The key

Dog id + `WebSearch` + sha256 of the input object exactly as the permission tool returns it in `updatedInput` (`server/permission-proxy.ts:168`), with keys sorted (S7). Nothing is normalised: one character different is another search, and it asks. The preview stored and shown is "Search", never the words.

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

**J2. Grants you already gave.** Recommended for each: it stops answering where it covers what the rule refuses, and stays in the Always allowed list ("No longer used" where it stopped) with Remove. What you would notice on the day it lands (review 3, read from code):
- **Your Mac's Always.** If your Mac is set to Always, every dog's command, write, delete and screen action on it asks again: at most one card per kind, per message, per dog (`server/mac-approval.ts:228-231`). Looking at files keeps working. Recommended: the Mac's Always covers reads only.
- **A dog holding the outside-delete key.** Its deletes outside its folders show a card each time, also in owner-auto (`server/laterdog/owner-auto-request.ts:33`, `:46`). Recommended: stop.
- **An app you tapped "Always allow" on.** Its sends ask each time on My Cloud (`server/laterdog/connector-ask.ts:52-54`); its other calls keep their answer. Recommended: the key covers only calls `alwaysAsks` does not match.
- **Saved commands** (desktop only; your cloud home has none). They stop answering; you notice only where cards appear (Auto-review, Custom, a shared workspace). Recommended: stop.
- **Teammate keys.** No change for your own work. Recommended: stop.
- **"Allow for this chat"** goes. You notice it only where cards appear.

**J3. An Always holds in every chat of that dog.** The key holds no per-chat value. Recommended: yes.

## Where the check runs, and its order

When a request opens (`request.opened`), the first that applies decides:
1. 207's `alwaysAsks` shows its card, before every stored grant, the old ones included: in `connectorSendDecision` before the always-allow and this-turn lines, in `settleOwnerAutoPermission` before `ownerAllows`, and in the Mac approval before its "always" mode.
2. The owner guard's hard refusals refuse.
3. **New: the lasting-allow lookup**, only for a request that passes A1 to A5. On a match the home answers allow and logs source `lasting-allow` with the rule id.
4. Everything as today.

- Every answer to an engine is allow-once: `updatedPermissions` is no longer passed on, "Allow for this chat" is removed, and an older app's `always: true` becomes allow once.
- Cards stop carrying the old keys: the connected-app send card and the outside-delete card carry no `allowKey`; the Mac card carries its Always only on read actions; the route refuses `connector:*` and the outside-delete key with 409 (S6).
- After the emergency downgrade, lasting allows are paused, not deleted.

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

Each takes the attack as its input.
1. `mcp__computer__key_press {"keys":"cmd+enter"}` on a `local-computer` card: no Always, line 5.
2. `mcp__agents__shared_computer {"action":"run_command","command":"ls"}`: no Always.
3. A person-set command server's `read_file {"path":"notes.txt"}`: no Always.
4. Removed kind, remote hand: a remote server's `browser_click {"selector":"button[type=submit]"}`: no Always, line 7.
5. Removed kind, remote send or payment: remote `mcp__resend__emails_create` and `mcp__bank__wire_funds`: no Always.
6. Removed kind, local address: a server at `http://127.0.0.1:8765/mcp` with `read_file`: no Always.
7. Removed kind, remote read: a remote server's `search_issues {"q":"x"}`: no Always.
8. A Codex MCP call with `argsUnknown`, and a Codex file change: no Always, line 4.
9. A Claude Edit or Write: no Always.
10. `WebFetch` of any address: no Always.
11. `WebSearch` with the same query twice: answered from the grant. One character different: a card. In another chat of the same dog: answered.
12. A search whose query holds a key the check sees: no Always, line 3.
13. A room turn the owner started, followed by a guest's message: no Always offered, and no answer from a grant.
14. A grant posted by a thread's starter who is not owner or admin: 403. A grant on an answered or dismissed card, or another dog's request id: 409.
15. Route posts with `allowKey` `connector:gmail` and with the outside-delete key: 409. Send cards and outside-delete cards carry no `allowKey`. A Mac command card carries no Always; a Mac read card does.
16. An older app answering `always: true` on an engine card: the engine gets allow once with no `updatedPermissions`.
17. The order: a stored `connector:<app>` key with a send; the outside-delete key in owner-auto; the Mac on Always with `run_command`. Each shows a card.
18. The stored preview is "Search", never the words.
19. Starting a teammate's turn: no Always, line 6.

## What the build will touch, in order

Desktop and home (each step one commit with its tests):
1. **The order fix** (`alwaysAsks` before the old grants): `server/laterdog/connector-ask.ts`, `owner-auto-request.ts`, `server/mac-approval.ts`. Test 17. It completes 207's promise and can land with 207 or first in this build.
2. **Old keys off the cards and the route**: `server/index.ts` (the send card at `:15654`, the outside-delete card at `:7308`, the route at `:17652-17674`), the Mac card. Test 15.
3. **The engine stops widening**: `server/permission-proxy.ts`; remove "Allow for this chat" on the desktop card. Test 16.
4. **The allow rule** (A1 to A5 as one function, and the turn's record of who reached it): new `server/laterdog/lasting-allows.ts`, `shared/lasting-allows.ts`. Tests 1 to 10, 12, 13, 19.
5. **The store, the grant route and the list endpoint**: `lasting-allows.ts`, `server/index.ts`. Tests 11, 14, 18.
6. **The lookup in `request.opened`**, logging `lasting-allow`.
7. **The desktop card and settings list**: `PendingApproval.tsx`, `en.json`, the dog settings (old grants with "No longer used").

Phone half (`later-dog-phone`, after step 5 lands): `src/ui/Cards.tsx` shows "Allow once" as the primary label, shows Always only when the card's `lasting.offered` is true (not when it carries an `allowKey`), and shows the why line otherwise; the settings list reads the new list endpoint with the same words.

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

- **Review 1:** findings 1 to 5 are closed by giving shell commands no Always (J4); 6 and 12 are stated limits; 7 is the order fix (also before the Mac's Always); 8 is closed (no teammate Always); 9 is A2; 10 and 11 are closed (hashes; no file Always); 13 is closed (`exec` and `run_on_computer` fail A4).
- **Review 2:** R1 to R4 are closed by A3 and A4 (no screen, local-server, Codex-without-input or teammate Always); R5 is J2 and the Mac card; R6 is moot (no server keys); R7 is A2 with S4's change; R8 is the route; R9 and R10 are the size table; R11 is the "Search" preview; R12 is closed (no `WebFetch` Always); R13 is closed (no file Always).
