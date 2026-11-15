# Item 45: what still asks

Read `/Volumes/fable-native/briefs/wave2/LEAD.md` first: it says how you work. Lane name `asks`, branch `fable/what-asks`. This lane starts with a written finding and a decision, then builds only what that decision says.

## What the person sees today and should see instead
Nearly every request a dog made on 14 November was allowed automatically, including pushes that skipped the checks, a process kill on the shared home, and opening a cloud console to create a sign-in client. The owner's standing rule is that a dog must not ask for what he already allowed (item 16) and also that nothing hard to undo happens without his yes. Wanted: a short list of things that always ask, whatever the approval mode, and a clear answer to "what still asks".

## Where it lives
- The approvals log and the automatic path: `GET /api/decisions` and `/api/decisions.csv` in `server/index.ts` (about line 19693), the approval modes (`approvalMode`, `autoApprove`, `alwaysAllow`) on a dog, `server/agent-tool-policy.ts` and its test, the owner guard (`OwnerGuardRefusal`, `ownerGuardAllowed` in `server/index.ts` about line 11705; the one rule it has now is deleting outside the workspace), and the automatic approval review (a one-shot model call in `server/drivers/claude.ts`, named in one place after the summary lane).
- Commands the home already refuses: `server/laterdog/heavy-commands.ts`; and in the combined branch `server/laterdog/home-signals.ts` (a dog's command that would stop the home or another dog's work is refused; 017a4792b, 075f32bf4, bd1125a38, 00430b924, b299ce57c). Do not duplicate it: extend its pattern if a new case belongs there.
- What a person sees: `src/components/PendingApproval.tsx` on the desktop and the phone's approval card.
- The audit that found this: `/Volumes/fable-native/study/audit-20261114/AUDIT.md` (the decisions section; it holds the owner's real chats, read it, never copy from it).

## What to build
1. Write down, from the log's categories and from the code, what is auto-allowed today, by which rule, and what asks. Propose a closed list that always asks regardless of mode, argued item by item: a push that skips the checks (`--no-verify`, the skip-hooks environment variable), a signal to a process the dog did not start, creating a sign-in client or key in a cloud console, deleting outside the workspace, sending on the person's behalf (mail, texts), paying, changing another account's settings. Keep the list short; every item says what harm it prevents.
2. Build the closed list as code in a new file under `server/laterdog/` (keep the diff in `server/index.ts` as small as possible), each rule with a test that fails before, including hostile spellings (an alias, a wrapper, a here-document, a command in a pipe: the existing guards had four rounds of these).
3. Make "what still asks" answerable: one plain sentence for the person in the approval settings, generated from the same list, so the text cannot drift from the code.
4. Say how this composes with item 16 (a lasting Always applies to what was approved; it must not widen past this closed list).

## Done means
The finding is written; each rule has a failing-before test; a reviewer attacks it at the exact commit and finds no spelling that passes; the settings sentence matches the code by a test.

## Out of scope
The lasting-Always design (item 16), the phone card's layout, the owner's accounts and approval history.

## What only a real home or phone can prove
That a real dog in auto mode is stopped at each rule and the card reaches a real phone and desktop, on an isolated server with a fake engine at most; a real engine's own way of phrasing a blocked command is only seen live.
