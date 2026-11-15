# Verify 3: combined head 26df021

**NOT READY.** Blocking: 1. A card answer that was still outstanding at a restart, and then fails for good, is never let go: the card stays "answering" and the answer is resent at every launch.

**N1: CLOSED, reproduced.** `n1-path.test.ts` drives the real `local-state`, the outbox, a real snapshot build, encode, parse and restore, and the sweep; only the disk and the stores are faked. Attach, then the send fails and the row shows Not sent with the copy kept. Kill and restart from the encoded snapshot: the copy survives the sweep. Retry sends it with the file present. Once the home has the message, the copy is freed. Copies for rows nobody retries last only as long as the snapshot keeps their rows: 60 rows saved, 50 restored, 50 copies kept. The 60 / 300 MB bound still holds. Sign-out deletes the folder.

**Card gap: PARTLY, reproduced in the same file.**
1. *Blocking.* After a restart, card-answers is no longer waiting on the answer's outcome, so nothing calls `abandon` if the resend fails. The entry stays unsent, the card stays answering, and every launch re-enqueues the answer (1 attempt on launch 2, 1 on launch 3). Fix: when the outbox gives up on an item that has a card, abandon it in the closer.
2. *Non-blocking.* An answer resent after a restart is sent even after the home shows the card answered another way: `answered()` drops the closer entry but not the queued outbox item. The window is a kill between the closer's save and the outbox write. Fix: when the home shows the card answered, also remove that `sendId` from the outbox.

**N2: CLOSED, reproduced (`repro-context.ts`).** Shares are never above 100%, and the bar never passes the heading's figure (0.50 with 50%, 0.85 with 90%).

**N3: CLOSED, reproduced.** Unknown part ids fold into "Everything else".

**N4: PARTLY.** A message 1 s newer than the breakdown, and a breakdown taken mid-turn, both show "as of" while collapsed. But a last message written even 1 ms after the reading also counts as stale. If the home stamps `at` before it saves the turn's final message, every breakdown shows "as of just now" without its segments. I could not read the home's `/context` route to check.

**New (non-blocking, measured).** `store.tsx` runs `keptAttachments.recheck()` in a layout effect on every change to `state.threads`. While any copy is waiting to be freed (every photo send until the home's message arrives, and every Not-sent photo, indefinitely), each such change makes one native `Directory.create` call and recomputes `attachedNames` over every thread once per waiting name. With 50 Not-sent photos on 84 chats of 200 messages each: 497 ms per 50 changes on this Mac (`repro-recheck-cost.ts`). Fix: compute the names once per recheck, and skip `folder()` when nothing is free.

**Not checked:** any device; the home's `/context` route; the full suite.

**Tests:** `heavy.sh pnpm exec vitest run` on 7 focused files: 55/55 passed. My `n1-path.test.ts`, run with vitest via the queue: 4/4.
