# Waiting for a shared computer

Run the fixtures in isolated homes, with local Boat and VPS stubs:

```sh
pnpm exec vitest run server/index.test.ts -t 'keeps every dog on its own computer|dispatches the conversation.s pinned computer|blocks bot-scoped Boat lifecycle'
pnpm exec vitest run server/vps-routing.test.ts -t 'runs two turns of one bot on the VPS at once'
pnpm exec vitest run server/turn-resources.test.ts server/computer-wait.test.ts server/shared-computers.e2e.test.ts
pnpm exec vitest run server/cloud-computer-slow-start.e2e.test.ts
pnpm exec vitest run server/managed-desktop-cleanup.test.ts
```

Every dog has its own computer, so waiting happens between conversations of
one dog. The VPS case proves a second conversation of the same dog waits for
the desktop by name, with the visible waiting row, and continues on its own
when the holder finishes. `server/turn-resources.test.ts` proves the
arrival-ordered waitlist: position 1 alone gets a released seat, a lazy claim
that never waited jumps no queue, and the estimate appears only once a wait
has completed. `server/computer-wait.test.ts` proves the waiting, parked and
resumed rows read as a queue position behind a named turn, never an error.
The cloud computer slow-start case proves that a lazily claimed cloud computer
tells a second conversation that another thread is using it.

The integration cases that drove queue order and parking through a shared
team computer were removed with team computers. No real-server fixture now
drives a turn to the wait ceiling; that path is covered by the unit tests
above.

Waiting is bounded by the computer wait ceiling (`LATERDOG_COMPUTER_WAIT_MAX_MS`,
30 minutes by default). At the ceiling the turn parks instead of failing, and
it resumes on its own when the computer is free. Cancellation checks the exact
turn generation.
Desktop ownership still spans a turn so screenshot/click sequences cannot
interleave. This is automatic waiting, not simultaneous control of one screen.

These fixtures do not contact Boat or operate the user's desktop. They verify
server behavior and transcript state, not visual rendering or a live Boat.
