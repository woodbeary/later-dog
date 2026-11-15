# Item 24: a question card can be answered again after the phone is killed

Read `/Volumes/fable-native/briefs/wave2/LEAD.md` first: it says how you work. Lane name `held-answers`, branch `fable/held-answers` in both repositories (home/edge in `later-dog`, phone in `later-dog-phone`).

## What the person sees today and should see instead
If the phone app is killed in the instant between an answer arriving at the edge or home and the phone writing its own record of it, the question card shows as answerable again after reopening the app, and the person can answer a question already answered. An approval card locks only once the home marks it no longer pending. Wanted: after reopening, a card the person already answered shows as answered, with no resend. The phone must never resend an answer by itself.

## Where it lives
- Phone repository (`/Volumes/fable-native/wt/phone-release` is the clean checkout; make your own worktree): the phone asks the edge only about answers whose ids it saved. See `src/lib/kept-answers.ts`, `src/lib/question-answers.ts`, `src/lib/question-card.ts`, and where cards are locked at start. A reviewer already looked at this: `/Volumes/fable-native/review/q-phone-reliability/verify-3/VERIFY.md` and `verify-4/VERIFY.md` describe the gap as "known and accepted" and say why an earlier attempt (a write-ahead record plus a resend, commit c0ef2b3) was wrong and was reverted. Do not bring it back.
- Edge (a Cloudflare Worker): `deploy/laterdog/home/src/desk.ts` and `desk-answer.ts`. The edge must list a person's held answers (ids the edge has received for this person) so the phone can lock those cards at start. Define the route, its access rule (the person's own session only), and its size bound.

## What to build
1. Edge: a read-only list of the person's held answers, tested in the edge's own test setup.
2. Phone: at start, ask the edge for that list and lock every card whose answer id is in it; keep the existing rule that a card also locks from what the home reports. The phone never resends.
3. A test that fails before: kill the phone after delivery and before its own record, reopen, and the card must be locked.

## Done means
Both tests fail before the change and pass after; the old reverted resend does not come back (a test that nothing resends); an independent review of both repositories says ready at the exact commits.

## Out of scope
The edge's deploy. An edge change ships only through a full deploy by the maintainer, test configuration first. Never run a deploy, never call a real edge. Also out: desktop cards.

## What only a real home or phone can prove
The race itself: kill a real phone app at the instant of answering and reopen it. With a real edge, that the list route is reachable with the phone's session and returns only that person's answers. Say plainly that fixtures cannot show either.
