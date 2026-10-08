// The motion tokens of src/styles.css, for the timers that must outlive the
// animation they wait for: a menu unmounting after its pop-out, the presence
// row leaving after its fade, a reply counted as "emerged". The stylesheet is
// the source of truth; motion.test.ts reads it and fails if these drift.
// See docs/laterdog/motion.md.
export const MOTION = {
  /** A control answering the pointer: hover, press, a dot appearing. */
  micro: 120,
  /** Something appearing in place: a bubble, a card, a menu, a pane behind a tab. */
  base: 200,
  /** Something arriving or settling: the mascot at a turn's tail, a tour beat, a panel. */
  enter: 320,
} as const;
