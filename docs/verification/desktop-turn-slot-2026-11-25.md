# Turn slot and reply landing

A working turn has one quiet face and status line. Authored replies remain complete bubbles; the UI does not divide one reply into display chunks. Historical user action controls retain their layout footprint while busy so their bubbles do not reflow on arrival.

## Reservation and following

Opening a turn while following reserves rounded 40% of the visible chat height. Glass header and composer insets are CSS measurements, including wrapped room headers and enlarged layouts. Reading history reserves no new room and keeps the reader's rows stable. A staged opening waits for its fill and final insets before completing its opening pin. The pending pin is cancelled when the turn ends or following stops. Later keyboard changes preserve the existing anchor rather than recomputing the opening reservation.

Entering message animations refresh the remembered anchor on both animation end and cancel. When the tiny visible area contains no message, a held, following turn uses its last message to account for prepends. Both animation listeners and the resize observer are removed on cleanup.

## Transcript window invariant

The default transcript window is 120 counted rows. While following, for the same owner, thread and turn key, its first index remains stable while new content is appended through the tail. The held following window may grow to 240 counted rows. Beyond that ceiling the existing last-user and tail rule applies. A new turn key or an explicit Jump to latest releases the hold. The default 120 is not the hard bound. No newest content is clipped or omitted to hold the first index.

Focused proofs cover 120 to 121 with the newest complete reply present, a second turn returning to 120 and then 121, explicit jump release, exactly 240 rows retained, release at 241 to the existing last-user rule (122 rows: the ask and all 121 appended rows), and a 500-row burst returning to 120 with the newest row present.

## Timing and panel pairing

Same-kind elapsed age is separate from the exact current step's age. A safe exact subject becomes eligible after that step's own minute and the existing one-second settling interval. Generic kind age can appear earlier while the current exact step is still young.

Dog and room work panels are siblings of the transcript. Closing returns focus to the current pane; changing owner or thread closes the old panel. The production fixture checks these transitions in normal and reduced motion, light and dark, at 1100px, 375px, CSS 200% at 375px, and an effective 188px enlarged viewport.

## Room ownership and incomplete history

Room status is derived from the room's own work, busy state, messages and native runs. A member's private approval wait, editing step or needs-you work cannot choose the room speaker or supply its status. An idle room with no retained runs keeps the earlier-work availability notice inline, so it remains visible without a work-panel opener. The notice remains scoped to its thread and persists after a failed refresh of history already known to be incomplete.

## Qualification

The production fixture builds actual components and CSS with Vite. Its store, fetch data and dispatch are synthetic. Raw exits, measurements, source hashes and original screenshots are retained with the overnight release evidence. This proof does not qualify native runs, backend persistence, a full App boot, installed Mac or iPhone behavior, or a full release gate. Linux font results remain distinct from the original Mac failure.
