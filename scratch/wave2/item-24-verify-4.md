# Verify 4: combined head a40fcd1

**READY TO SHIP AS AN UPDATE.** Nothing blocking.

- Card revert: complete. `card-close.ts` and `card-answers.ts` are byte-identical to `b79b963`, and nothing still refers to `begin`, `abandon` or `answering()`. The residue is the narrow one you describe. An answer held at the edge stays marked answering through held sends, which are saved to disk. The other ways a card becomes answerable again are a close the home refuses ("drop") and sign-out.
- Copy recheck: my `n1-path.test.ts` passes on this head without changes to the photo path. Its two card tests were not run, because they exercise the write-ahead you removed. After a delivery, a deleted row, an attachment removed from the box, or sign-out, the copy is freed. Not-sent and held messages keep theirs, and the sweep spares them. The bound holds with 50 copies restored.
- Context row: the home's `stale: true` is honoured. With the 5-second tolerance, a message within 5 s after the reading no longer marks the breakdown stale; the 2% drift on the live count still does.

**Carry forward (non-blocking):** the two card cases from verify-3 are now accepted residue; when the parts add up to more than the total, the shares are scaled down and marked "about"; the "as of" wording can only be checked against the home's `/context` route.

**Only a phone proves:** keyboard and message box geometry; copy timing on large files; the iOS cache being emptied; real home timings for the context reading.

**Tests:** `heavy.sh pnpm exec vitest run` on 8 focused files: 58/58 passed. `n1-path.test.ts` (photo path): 2/2 passed. The context script ran.
