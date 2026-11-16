# Always on an approval: design (item 16, stage one, revision 6)

Status: design only, ready for code once this revision is checked. Base: `main` 0651657, with item 45 (pull request 207, head 395406d) not merged yet. Revision 6 answers review 5 (Relay, `handoff/round4/item-16-REVIEW-5.md`): the allow rule is unchanged; J2 gains the saved-login Always and the keys a dog-made dog copies, the search input stays on the home, and an ACP engine can no longer fall back to its own "always". The answers to reviews 1 to 5 are at the end.

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
| A2. Only the owner reached this turn | Fails for every turn in a group chat (a room), so a room card says "Only the owner can choose Always." and the grant route refuses it with 409 (`why: "owner-only"`). In a one-to-one chat it is worked out when the request opens, from the chat's own messages since this dog's last reply: every person message is from the owner or an admin and not posted through the local API, no line is from another dog whatever its role, and a routine's run counts as its writer's (G4) | the thread's messages since the turn began | a guest's turn; a guest's message queued before the turn and delivered during it; a shared-workspace member; another dog's message |
| A3. Whole input carried | The driver set the new `wholeInput` field to the tool's whole input object, the same object the engine runs (G2) | `wholeInput` on `request.opened` | every request whose driver does not set it: every non-Claude engine today, and a Claude request missing it |
| A4. On the allow list | The pair (driver, tool) is on a fixed list of engine tools whose whole effect is their input. The list holds one pair: (Claude, `WebSearch`) (G3) | the driver kind and the tool name | every tool of every server (later.dog's own, the person's, local or remote), shell, file edits, `WebFetch`, screen and Mac actions, starting a teammate's turn, another driver's tool titled "WebSearch", anything new |
| A5. No secret in the input | `redactSecretsInText` leaves the canonical input unchanged | the canonical input | a query holding a password or key the check can see |

A new tool or engine fails A4 by default. A kind joins the list only with its own tests and attack review.

### The key

Dog id + `claude` + `WebSearch` + sha256 of `wholeInput` with keys sorted (S7, G2). For Claude, `wholeInput` is `ask.input`, the object the permission proxy returns as `updatedInput` (`server/permission-proxy.ts:168`); today the driver sends only `askedFields(ask.input)` (`server/drivers/claude.ts:469-478`, `:1491`), which drops `query`, `allowed_domains` and `blocked_domains`, so step 4 adds the field, only for (Claude, `WebSearch`), and the home strips it from every event it sends or stores (H2). Nothing is normalised: one character different is another search, and it asks. The preview stored and shown is "Search", never the words.

The new store is keyed by the dog's id, so a dog-made dog (a new, random id) inherits no grant from it. The old keys are different: today a dog-made dog copies its creator's whole `alwaysAllow` (`server/laterdog/dog-creation.ts:74`), which J2-e turns off.

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

**J2. Grants you already gave (restated after review 4).** Main has six lasting answers besides the engine's own, plus the way a dog-made dog copies them. Two are settled by J1 itself; the rest are your choice, each its own commit, landed only if you choose it.

Settled by the order fix (step 1), which any build lands first:
- **The outside-delete key.** Every delete outside a dog's folders is one of 207's five kinds, so once `alwaysAsks` runs before the key, the key answers nothing. "Keep" is not possible under J1. What you would notice: a dog holding it shows a card for each outside delete, also in owner-auto (`server/laterdog/owner-auto-request.ts:33`, `:46`).
- **An app's "Always allow" (`connector:<app>`) for sends.** Every send is one of the five, so the key stops answering sends; it keeps answering the app's other calls. What you would notice: that app's sends ask each time on My Cloud (`server/laterdog/connector-ask.ts:52-54`).

Your choice, each with what stays open if you keep it:
- **J2-a. Saved exact shell commands** (`command-allowlist.json`, desktop only; your cloud home has none). Recommended: stop. If kept, review 1's findings 1 and 4 stay open for them: on Claude the saved folder is the engine's start folder, not where the shell has gone, and nothing pins what the arguments point at. What you would notice if stopped: those commands ask where cards appear (Auto-review, Custom, a shared workspace).
- **J2-b. Teammate keys** (`ask_bot`, `delegate_bot`). Recommended: stop. If kept, review 2's R4 stays open: a dog holding the key sends any words to a teammate that can read things it cannot, such as mail. What you would notice if stopped: no change for your own work (`peerReviewRequired` is off there).
- **J2-c. The Mac's Always.** Recommended: it covers reads only. If kept as it is, every dog's command, write and screen action on that Mac runs with no card (`server/mac-approval.ts:228`), which J4 refuses for everything else; the five kinds (a delete outside the dog's folders, a push past the checks and the rest) still ask first through 207's own check. What you would notice if changed: each such action asks again, at most one card per kind, per message, per dog; looking at files keeps working.
- **J2-d. "Always use this saved login"** (`vault:<site>`, `server/laterdog/secure-form.ts:423`, `server/index.ts:12734-12738`). After you tick always once, any later sign-in form for the same site comes back already filled, with no card (`secure-form.ts:484`). "The same site" is the last two parts of the address (`shared/vault.ts:57-65`), so a login ticked on `accounts.google.com` also fills a form on `docs.google.com`, and the dog chooses where on the page to type it (`secure-form.ts:214-215`). Recommended: stop. Each fill then shows its card, and the keys list as "No longer used". What you would notice: one card each time a dog signs in for you. If kept, it stays exactly as it is on main: any page of the same site, where the dog chooses the box. A possible later step, not in this build: fill only on the exact address where you ticked it. A check that the box is a username or password field may not be buildable: the fill drives the screen and reads only the address bar, not the focused field (`server/laterdog/secure-form.ts:194-215`).
- **J2-e. Dogs a dog makes copy their maker's keys** (`dogMadeDogAccess`, `server/laterdog/dog-creation.ts:74`). Recommended: copy none. What you would notice: a dog that another dog made asks again for an app, a teammate or a login its maker was allowed. What is copied: a made dog copies its maker's dog record, which holds the outside-delete key and the saved-login keys; app keys and teammate keys live on a chat and are copied only from the maker's main chat (`server/index.ts:14397`, `:11790-11797`). If kept, those keys spread to every dog it makes, with no card.

Not a choice: **the engine's own "Allow for this chat"** goes (step 3), on every engine, because the engine decides how wide it is (design A). You notice it only where cards appear.

**J3. An Always holds in every chat of that dog.** The key holds no per-chat value. Recommended: yes.

## Where the check runs, and its order

When a request opens (`request.opened`), the first that applies decides:
1. 207's `alwaysAsks` shows its card, before every stored grant, the old ones included: in `connectorSendDecision` before the always-allow and this-turn lines, and in `settleOwnerAutoPermission` before `ownerAllows`. On the lent Mac, 207's own check at later.dog's endpoint already asks first for every call of the five kinds, before the Mac approval is consulted, so the Mac approval itself is not changed (a second check there only added a second card, with an old-style Always).
2. The owner guard's hard refusals refuse.
3. **New: the lasting-allow lookup.** It runs A1 to A5 on every request, not only at the grant (G7); only a request that passes all five is looked up. On a match the home answers allow and logs source `lasting-allow` with the rule id.
4. Everything as today.

- Every answer to every engine is allow-once: the home sends `always: false` in its one answer path (`server/index.ts:5369`), the Claude proxy passes no `updatedPermissions`, ACP accepts only an `allow_once` option and no longer remembers an operation for the chat (`server/drivers/acp/core.ts:903-913`, `:918`, `:967-972`), and no card carries `allowSession` (`server/index.ts:7305`, `server/drivers/claude.ts:1496`, `acp/core.ts:1010`) (G1c). An ACP engine that offers only an "always" option has its request cancelled with the existing message that it offered no allow option (H3); the person sees that line in the chat, and the dog carries on without that step. A deny likewise accepts only `reject_once`: an engine that offers only `reject_always` has the request cancelled, so no engine remembers a "never" either.
- Cards stop carrying old keys: the send card and the outside-delete card carry no `allowKey`; with J2-a no card carries `commandAllowlist`; with J2-b the teammate card carries no `allowKey`; with J2-c the Mac card offers Always only on reads. The route refuses every key it no longer honours with 409 (S6, G1).
- After the emergency stop, lasting allows are paused, not deleted; today the stop clears only a Full or Custom chat's keys (`server/index.ts:9613-9620`), so the pause is added in step 4 (G5).

## What is stored and where

- `server/laterdog/lasting-allows.ts` writes `lasting-allows.json` in the home's data folder (mode 600, atomic writes, the same checks as `command-allowlist.json`).
- Each rule: `{ version: 4, id, botId, kind: "search", keySha256, preview: "Search", grantedAt, grantedBy, fromThreadId }`. At most 500 rules per dog. An unreadable file matches nothing.
- The grant route, `POST /api/bots/:id/always-allow`, takes the pending request's id, finds the card by bot, thread and request id, unanswered and not dismissed, checks owner or admin of the turn itself (not `cardAnswerRefusal`), recomputes A1 to A5 from the home's own copy, and refuses with 409 if any fails.

## How a person lists and removes them

Dog settings, section **Always allowed**: every rule and every old grant (J2), newest first, each with what, where, when and **Remove**; old grants that stopped show "No longer used". Removing takes effect at once; deleting the dog removes its rules. The list refreshes as soon as a grant is saved. The phone shows the same list.

Row words, the same on the desktop and the phone: search "Search for the same words"; app "Use {app}" with the app's proper name; outside-delete "Delete files outside its own folders"; saved-login "Sign in to {site} with your saved login"; teammate "Start work with {name}"; command "Run {command}". The second line says "Allowed {date}", in the person's own time zone, when the grant is active and has a time on record, and "No longer used" when it stopped. The footer "{name} does these without asking you first. Remove one and {name} asks again next time." shows only when at least one row is active and the list is not paused. An unreadable store shows "later.dog could not read part of this list. A search you allowed asks again until it can." instead of an empty list, with the old grants the home can still read listed under it, each with Remove.

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

Settled in the build (step 4): A3 is read in two parts so lines 5 to 7 can be reached. A request from a driver that never carries a whole input (every driver but Claude today) fails A3 first and shows line 4. A Claude request is checked against A4 next, so a screen action shows line 5, starting a teammate's turn line 6, and anything else line 7; only a listed pair that arrives without its whole input shows line 4. This is what build tests 1, 4 and 8 already expect. A5 is checked only when the whole input is there.

"What this covers", search: "Always allow lets {name} search for exactly this again without asking, in any of its chats." The card's `lasting.reach` carries this sentence in English with the dog's name filled in; the desktop shows its own translated copy of the same sentence.

Answered card: "Always allowed". Settings: "Always allowed", "Remove", "No longer used", "Paused", "Resume", empty "Nothing yet. Tap Always allow on a card and it shows here."

Wire: `lasting?: { offered: true; reach: string } | { offered: false; why: "always-asks" | "owner-only" | "secret" | "incomplete" | "screen" | "teammate" | "state" }`.

### Old keys during steps 1 to 5 (settled for the build)

In steps 1 to 5 the `lasting` field is the rule for new grants only. A card that still carries an old key (the teammate card, the Mac card, the secure form, a saved command) gets no `lasting` field and shows exactly what it shows on main, until its own step (6 to 9) lands. `lasting` goes on engine tool cards: the cards that had "Allow for this chat". This keeps the optional steps optional: no step 1 to 5 changes what a kept old grant does or how it is offered.

### The grant and list endpoints (the phone's contract)

- **Grant:** `POST /api/bots/:id/always-allow` with `{ threadId, requestId }` and no `allowKey`. The home finds the pending engine card by bot, thread and request id (unanswered, not dismissed), checks owner or admin, recomputes A1 to A5 from its own copy of the request, and stores the grant. The client then answers the card with the existing `POST /api/threads/:threadId/respond` `{ requestId, behavior: "allow", scope: "always" }`; the engine still gets allow once. The old `{ threadId, allowKey }` form keeps working for the cards that still carry a key. Answers:
  - `200 { granted: true }`;
  - `400 { error }` when neither `requestId` nor `allowKey` is given;
  - `403 { error }` when the person is not the owner or an admin;
  - `404 { error }` for an unknown dog, or a `threadId` that is not one of its chats;
  - `409 { error, why }` when the rule refuses (`why` is one of the seven `lasting.why` values; a group chat's card gives `owner-only`);
  - `409 { error }` when the card is not pending for this dog, and when `threadId` is left out and the dog has more than one chat;
  - `503 { error }` when the store cannot be read.
- **List:** `GET /api/bots/:id/always-allowed` returns `{ paused: boolean, unreadable?: true, items: Array<{ id: string; kind: "search" | "app" | "outside-delete" | "saved-login" | "teammate" | "command"; subject?: string; grantedAt?: string; state: "active" | "no-longer-used" }> }`.
  - `subject` is the app, the site, the teammate's name or the command's redacted preview; a search has none.
  - `grantedAt` is on every item with a time on record; today that is the search grants only (old keys and saved commands were never stored with a time).
  - Rows carry no place: the "where" earlier revisions named is dropped, because every remaining grant holds in every chat of the dog.
  - Old keys come from the dog's record and every one of its chats, and saved commands from `command-allowlist.json`. In steps 1 to 5 the outside-delete key lists as `no-longer-used`; an app key stays `active` (it still answers calls that are not sends).
  - `unreadable: true` when the store cannot be read: nothing is answered from it, and the list shows one quiet line instead of the searches.
  - `404 { error }` for an unknown dog; `403` for anyone but the owner or an admin.
- **Remove:** `DELETE /api/bots/:id/always-allowed/:itemId` removes one item (a search grant, an old key from the record and every chat, or a saved command) and returns the list. `404` when the item is already gone: a client treats that as done. `503` when the store cannot be read.
- **Resume after the emergency stop:** `POST /api/bots/:id/always-allowed/resume` clears `paused` and returns the list; `503` when the store cannot be read.
- Owner or admin only, for all four. When a card carries both `lasting` and an old `allowKey`, a client follows `lasting` and ignores the key (no card does today); the desktop and the phone both do. A viewer who is not the owner or an admin sees no Always button on an offered card, only the line "Only the owner can choose Always."

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
16. An older app answering `always: true`: through the home's answer path, the Claude proxy and an ACP engine, each gets allow once; on ACP the allow-once option is picked and the same input asks again. An ACP engine that offers only `allow_always`: the request is cancelled with the "offered no allow option" message, in the answer path and in full-auto, and nothing is remembered (G1c, G8, H3).
17. The order: a stored `connector:<app>` key with a send, and the outside-delete key in owner-auto, each show a card. On the lent Mac, a delete shows exactly one card, 207's, with no Always, and runs after Allow.
18. The stored preview is "Search", never the words.
19. The allow rule returns "not offered, teammate" for a request that starts a teammate's turn. The teammate card itself does not change in steps 1 to 5; it changes only in step 7 (see 23).
20. No card carries `allowSession`; an older phone shows no "Allow for this chat" (G1c).
21. A Claude `WebSearch` event carries `wholeInput`; with it missing there is no Always; two searches with the same `query` and different `allowed_domains` get different keys. No client frame, member frame, replay buffer entry or stored event holds `wholeInput`; a Claude `Write`, `Edit` or MCP request has no `wholeInput` at all (G2, H2).
22. A Pi request titled "WebSearch" that carries an input gets no Always (G3).
23. With J2-b: through `requestPeerApproval` with a stored `delegate_bot` key, a card shows; the teammate card has no `allowKey`; the route refuses `ask_bot:*` and `delegate_bot:*` with 409.
24. With J2-a: a saved rule for exact text and folder exists; the same request shows a card; no card carries `commandAllowlist`; `POST /api/bots/:id/command-allowlist` returns 409; the rules list as "No longer used".
25. With J2-c: the Mac in "always" mode; `run_command`, `write_file`, `delete_file` and `computer_call` each show a card; `list_files` and `read_file` do not.
26. Another dog's message reaches an owner's turn, then a search: no answer from a grant (G4).
27. After the emergency stop, the search grant is paused and the search asks; after Resume it answers (G5).
28. Deleting a dog removes its search grants; an unreadable store answers nothing and refuses new grants (G7).
29. With J2-d: a stored `vault:google.com` key and a secure form for `docs.google.com` show the card; the key lists as "No longer used" (H1).
30. With J2-e: a creator holding dog-record keys (`vault:*`, the outside-delete key) and main-chat keys (`connector:*`, `delegate_bot:*`) makes a dog through `create_bot`; the new dog holds no `alwaysAllow` key on its record or its main chat (H1, G7).

## The build order

Each step is one commit with its tests. Main is safe after any step alone: no step adds a lasting answer before the step that checks it, and between step 3 and step 5 cards have no lasting choice (a step back only where cards appear today: Auto-review, Custom, a shared workspace). **The smallest set the Mac session can land with none of Jacob's choices made: steps 1 to 5.** Steps 6 to 10 each land only if Jacob chooses them.

| # | Commit | Files | Tests | Needs a J choice | Main after it alone |
|---|---|---|---|---|---|
| 1 | The order fix: `alwaysAsks` before the old grants | `server/laterdog/connector-ask.ts`, `owner-auto-request.ts` | 17 | No (completes J1; can land with 207) | Safe: the outside-delete key and app keys stop answering 207's kinds |
| 2 | Send and outside-delete cards drop their keys; the route refuses them | `server/index.ts` (`:7308`, `:15654`, route `:17652-17674`) | 15 | No | Safe |
| 3 | No engine widens a chat: `always: false` to every engine, ACP accepts only `allow_once` and `reject_once` (else cancels), no `allowSession` on any card, no `updatedPermissions` | `server/index.ts` (`:5369`, `:7305`), `server/permission-proxy.ts`, `server/drivers/acp/core.ts` (`:903-913`, `:918`, `:967-972`, `:1010`), `server/drivers/claude.ts` (`:1496`, outside the compaction window) | 16, 20 | No | Safe: answers become allow-once |
| 4 | The allow rule and the store: A1 to A5, `wholeInput` for (Claude, `WebSearch`) only and stripped from every event, the store, the grant route, the list endpoint, the lookup, the emergency pause | new `server/laterdog/lasting-allows.ts`, `shared/lasting-allows.ts`; `server/drivers/claude.ts` (`:1491`); `shared/runtime-events.ts`; `server/index.ts` (`request.opened`, `:7120`, the route, `:9613-9620`) | 1 to 14, 18, 19, 21, 22, 26 to 28 | No | Safe: a search grant is stored and answered in the same commit |
| 5 | The desktop card and the settings list | `src/components/PendingApproval.tsx`, `en.json`, the dog settings | card rendering of the why lines and "Always allowed" | No | Safe |
| 6 | Saved commands stop | `server/index.ts` (`:5374-5377`, `:7258`, `:7303`, the command-allowlist route), `PendingApproval.tsx` (`:203`, `:294`) | 24 | **J2-a** | Safe |
| 7 | Teammate keys stop | `server/peer-approval.ts` (`:93-99`, `:128`), the always-allow route | 23 | **J2-b** | Safe |
| 8 | The Mac's Always covers reads only | `server/mac-approval.ts` (`:203-210`, `:228`), the Mac card | 25 | **J2-c** | Safe |
| 9 | Saved-login Always stops | `server/laterdog/secure-form.ts` (`:423`, `:484`), `server/index.ts` (`:12734-12738`) | 29 | **J2-d** | Safe: each fill shows its card |
| 10 | Dogs a dog makes copy no keys | `server/laterdog/dog-creation.ts` (`:74`) | 30 | **J2-e** | Safe |

Phone half (`later-dog-phone`), after step 4 lands (G5): `src/ui/Cards.tsx` uses "Allow once" as the primary label, shows Always only when the card's `lasting.offered` is true, shows the why line otherwise, and no longer reads `allowKey` or `allowSession` for a lasting choice; the settings list reads the new list endpoint with the same words. An older phone against the finished home shows "Allow" and no "Allow for this chat". It still shows an old-style Always on the cards whose old grant Jacob kept: the teammate card (unless step 7), the Mac card (on every action unless step 8, on reads after it) and the secure form's "always" (unless step 9); the desktop still offers "Always allow this command" unless step 6.

None of the files ROUND4 reserves.

## If Jacob takes none of the optional steps (6 to 10)

Nothing steps 1 to 5 add opens a path. These stay exactly as on main today:
- **Saved shell commands** answer from the folder the engine started in, not where the dog is working, and nothing checks what their file names point at now (review 1, findings 1 and 4).
- **Teammate keys** let a dog send any words to a teammate that can read things it cannot, such as mail (review 2, R4).
- **The Mac's Always** lets every dog run commands, write, delete and use the screen on that Mac with no card.
- **The saved-login Always** fills your password on any page of the same site, where the dog chooses the box (H1).
- **Dogs a dog makes** copy all of those keys from their maker.
- **An app's Always** still answers that app's calls that are not sends.
- **Connected-app deletes and shares** never ask (item 45's list, outside this item).

## Other lasting answers checked, which need no change (H4)

- The connected-app "this turn" answer (`server/laterdog/connector-ask.ts:54`): lasts one turn; after step 1 it no longer answers sends.
- The Mac's per-message grant (`server/mac-approval.ts:230-231`, `:255`): one message, one kind.
- The routine and model "apply directly" paths (`server/index.ts:9832`, `:10124`, `:10129`): they confirm settings, not tool requests.
- Writing `alwaysAllow` on a dog (`server/index.ts:17983-18002`) and new-dog defaults (`server/new-bot-defaults.ts:39`): the owner's or an admin's own writes; once a key's reader ignores it (steps 1, 6, 7, 9), writing it changes nothing. A write from the machine itself falls under the limit that a dog can write the home's data.

## Limits, stated plainly

- **A dog's shell can write the home's data** on a cloud home, so a dog that runs code can grant itself anything, today as before. Closing it needs dogs to run as a separate user from the home.
- **Check, then use:** between the home's answer and the engine's action, a process already running can change things. A search sends only its words.
- **A search's results change from day to day.** The key pins the words, not the answers.

## What only a real home or phone can prove

- A search's Always holds in another chat of the same dog after a real restart.
- The phone shows the card, stores the grant and lists it.
- Which cards Jacob really sees in a week (the size table is read from code).
- A guest's message reaching a running owner turn (A2) as a real room does it.

## Answer to review 5

| # | Finding | Answer | Where it changed |
|---|---|---|---|
| H1 | "Always use this saved login" is a lasting answer J2 did not list | Accepted: J2-d (recommended stop, step 9, test 29; the exact-host and field-type fill written down as the other choice with what stays open) and J2-e (dogs a dog makes copy no keys, step 10, test 30). Listed as Jacob's choice, not "no choice", because he would notice a made dog asking again | J2; build order; tests 29, 30 |
| H2 | `wholeInput` must stay on the home | Accepted: only for (Claude, `WebSearch`), stripped from the public event at `server/index.ts:7120`, never stored; test 21 extended | The key; step 4; test 21 |
| H3 | ACP falls back to the engine's own "always" | Accepted: `optionFor("allow")` accepts only `allow_once`, with none the request is cancelled with the existing message; the person sees that line | Order of checks; step 3; test 16 |
| H4 | Other lasting answers | Recorded; none needs a change | "Other lasting answers checked" |
| G7 | A dog-made dog inherits the old keys | Accepted: the sentence now says the new store is safe by id and the old keys are copied today; step 10 | The key; G7 row |

## Answer to review 4

| # | Finding | Answer | Where it changed |
|---|---|---|---|
| G1 | Three lasting answers on main survive the build | Accepted: step 3 sends `always: false` to every engine and removes `allowSession` from every card (G1c); steps 6 and 7 (revision 6 numbers) stop saved commands and teammate keys if Jacob chooses (G1a, G1b), and J2 says which earlier finding stays open if he keeps either | Order of checks; J2; build steps 3, 6 and 7 (revision 6 numbers); tests 16, 20, 23, 24 |
| G2 | The home does not hold a search's whole input | Accepted: the Claude driver adds `wholeInput` (`ask.input`) to `request.opened` in step 4 (step 6 in revision 5), for (Claude, `WebSearch`) only; A3 and the key read only it | A3; the key; test 21 |
| G3 | A4 reads a name some drivers take from free text | Accepted: the list holds the pair (Claude, `WebSearch`) | A4; test 22 |
| G4 | A2's record would have a gap | Accepted: A2 is read from the thread's own messages when the request opens, as 207 does; any non-owner person or other dog fails it; a routine counts as its writer's | A2; tests 13, 26 |
| G5 | The order, the phone and the pause | Accepted: the phone lands after the rule and store (step 4 in revision 6); the emergency pause is in that step; J2 says the order fix settles two | Build order; J2; test 27 |
| G6 | The Mac's reads-only is in no step | Accepted: step 8, after J2-c | Build order; test 25 |
| G7 | The lookup in other states | Accepted: A1 to A5 run on every request; a dog-made or recreated dog has a new id and inherits nothing from the new store. The old keys are copied today (review 5); J2-e and step 10 turn that off | Order of checks; the key; test 28, 30 |
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
