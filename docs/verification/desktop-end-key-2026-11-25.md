# Conversation End shortcut scope

Pressing End on a sidebar or menu control previously moved the conversation to its latest window and resumed following, discarding the reader's position.

The shortcut now applies to the page, ordinary content in the current transcript, and an empty chat composer. Interactive transcript controls, menus, unrelated fields, text editing and modified keys retain their own key behavior.

## Behavior evidence

Before the change, the new DOM and viewport regressions both failed: the unrelated control's End event was consumed and following changed from false to true.

After the change, all 45 tests in `src/hooks/end-key.test.ts` and `src/hooks/use-transcript-viewport.test.ts` passed on the cloud computer. The viewport test also checks unchanged scroll position, scroll calls and visible message IDs, then verifies that End from the page still jumps to the latest messages.

Full typecheck, lint, locale validation and 14 no-comments checks passed. The full merge gate must still end in VERDICT: PASS before merging. These checks use isolated fixtures and do not send messages to the owner's home.

The change affects keyboard scope; the existing transcript gallery remains the rendering fixture. Native Mac app behavior has not been observed because screen access is not lent.
