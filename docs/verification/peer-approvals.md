# Peer approval outcomes

Run the focused regression tests and the isolated HTTP workflows:

```sh
pnpm exec vitest run server/peer-approval.test.ts
pnpm exec vitest run server/thread-aware-bots.e2e.test.ts server/room-coordination.e2e.test.ts --maxWorkers=1 -t "approval"
```

The owner's own dogs never get a peer-approval card: in the owner's workspace,
`coordinate_bots` sends at once even when `approvePeerComms` is on. The card is
kept only for a hosted or shared-sign-in workspace and for conversations a
guest drives. The HTTP tests launch disposable servers with the repository's
fake engine and switch them to a shared sign-in workspace by saving two admins
through `PUT /api/config`. Unit tests advance the production fifteen-minute
deadline with fake timers.

The checks cover:

- `server/peer-approval.test.ts`: user approval permits work; denial, expiry
  and cancellation block it. Deleted peers and interrupted threads cancel
  approvals without attributing a decision to the user; late answers cannot
  revive settled requests. Stale cards from a previous run are dismissed.
- `server/thread-aware-bots.e2e.test.ts`, "waits for the person's approval
  card in a shared sign-in workspace": a direct `coordinate_bots` call raises
  the card and enqueues nothing while it is open. Deny answers 403 "The person
  said no; no work sent." with the recipient's `approvalOutcome`, and the
  recipient gets no work. Allow queues the work with `approvalGranted: true`.
- `server/room-coordination.e2e.test.ts`, "honors allow/deny on the sender's
  peer-approval card in a shared sign-in workspace": the same outcomes for a
  room request, including the refusal the sender's model sees on deny.
- `server/room-coordination.e2e.test.ts`, "presents all peer approvals
  together in a shared sign-in workspace": a multi-recipient request raises
  one card per recipient and dispatches nothing unless every recipient is
  allowed.
- The owner-workspace counterparts in both e2e files, "sends an owner's dog's
  ... request without ... card": with `approvePeerComms` on, the owner's dog
  sends at once with `approvalGranted: false` and no card.
- Hiding a peer does not stop it: hidden is a list filter only.
  `server/peer-roster.test.ts` keeps a hidden teammate reachable and
  resolvable by name; no approval test hides the recipient.

This proves server behavior, not native UI rendering or real-model reasoning.
A guest-driven Cloud conversation takes the same `peerReviewRequired` branch as
the shared sign-in workspace but is not exercised here.
