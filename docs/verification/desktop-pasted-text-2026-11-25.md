# Desktop pasted text files

A paste with at least 900 UTF-16 code units or 12 lines becomes an attachment chip. This preserves the desktop's existing boundaries and is the shared phone/desktop cutoff selected by the lead. CRLF counts as one break; lone CR, LF, Unicode line separators and paragraph separators count as line breaks.

The existing draft stays in the box. A selected part of the draft is replaced as with a normal paste. Each attachment gets a text/plain file named Pasted text.txt, Pasted text 2.txt, and so on. Sending uses the standard attached-file message shape. Display in chat box restores the original text for editing, and Remove leaves the remaining draft intact.

Send waits while an upload is pending. Completing an upload cannot bring back an attachment the person removed. Existing saved paste drafts remain readable and can still use their original inline representation; an upload failure also keeps the original text available.

## Checks

The original newline-only detector failed the alternate-line-ending cases. The paste workflow tests also require the uploaded file send shape. Before the lead restored the original cutoff, a provisional 2,000/40 implementation passed 134 focused checks; the final restored cutoff is checked again before merge.

The paste workflow checks inspect the uploaded File contents and the sent message, including accented text and emoji. They also check exact cutoff boundaries, all supported line endings, removing an in-flight upload, editing a paste, selected draft text, unique names and clearing the sent draft.

The composer gallery includes pasted-text and pasted-text-line-breaks scenes. The isolated Mac capture recipe is outside the repository at ~/laterdog-wt/review/desktop-overnight/capture-paste-baseline.py, with before-final and after-final evidence folders alongside it. It dispatches a clipboard event containing 12 CR-separated lines and emulates the browser's default insertion only when that event is not handled. Light and dark, 1,100 px and 375 px, reduced motion and enlarged content are covered by that recipe. Final visual review is recorded in the pull request.

Native Mac application observation is unavailable because screen access is not lent. A complete merge gate ending in VERDICT: PASS for the final candidate is required before merging.
