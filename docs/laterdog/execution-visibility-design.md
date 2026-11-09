# Execution visibility and a smaller shared contract

The durable native projection and compact desktop/phone surfaces below are implemented and merged. The final server image passed its production activation and ten-minute functional window; the phone beta is published. Storage headroom and large live capacity remain unqualified. Publication does not prove installed-device behavior; see [release evidence](../verification/consolidation-release-2026-11-08.md).

## Current owners

The server owns conversations, queues, account continuation and canonical runtime
events. Engine adapters own native sessions and report provider events. The
supervisor separately owns durable cloud jobs and publication receipts. Clients
project these facts into conversation, activity and account screens. Execution
evidence records selected, dispatched and reported models in the usage ledger.

`server/laterdog/helper-board.ts` is an in-memory live board whose settled entries
expire after ten seconds. It is not a durable puppy history. The desktop and phone
retain helper snapshots only for legacy or unavailable native activity. The native lifecycle is persisted by the server and projected through the shared contract and selectors. The phone retains bounded live snapshots, revalidates paginated history on reconnect/focus, batches frames and selects state for mounted views. These code changes do not by themselves establish fewer device crashes or lower heat.

## Designs considered

1. Let each client maintain its own work lifecycle and recovery rules. This keeps
   clients independent but duplicates facts and permits disagreements after a
   reconnect. It fails the single-owner requirement.
2. Share an entire client store and screen implementation. This couples native
   and desktop lifecycles while still requiring a canonical server authority.
   It is larger than the boundary needs.
3. Preserve existing execution owners, correlate their identities, and expose a
   shared versioned projection plus framework-independent parsing and selectors.
   Clients own interaction and local unsent input. This is the chosen direction.

## Caller contract

A conversation reads its work snapshot, subscribes from that snapshot's event
cursor, and selects only the fields it renders. A detail drawer retrieves durable
attempts, puppies, handoffs and artifacts by identity. A completed parent does not
erase a child record. Reconnect replaces a projection from a fresh snapshot and
deduplicates replayed events. Commands retain existing send identities and
generation checks; a lost reply must not execute them twice.

The projection distinguishes a dog, its assigned work, native puppies and delegated
dogs. It also distinguishes selected settings from running settings, waiting for
a person from waiting for a resource, and provider completion from independently
verified results. Backend cancellation and background limitations remain explicit.
Native engine scheduling is not replaced with another orchestration loop.

## Consolidation boundaries

- Generate or share the wire contract and pure selectors across clients. Remove
  hand-maintained copies after a parity fixture proves each consumer.
- Derive roster, chat, activity drawer and account status from the same facts.
  Preserve distinct execution states instead of collapsing them into a busy flag.
- Keep one compact activity line in the chat. Expand puppies and delegated work
  on demand. Keep full peer exchanges in their own conversations.
- Subscribe mounted views to their thread or account. Batch rendering updates,
  flush terminal transitions in order, and keep background transcript windows
  bounded without discarding durable messages or unsent input.
- Keep active engine state hot. Archive inactive material only after verified
  storage and restore checks. A browser environment and a shell environment stay
  separate capabilities behind the existing execution interfaces.

## Remaining qualification

The mapped fixtures cover native restart, late events, parent/child separation, visibility, guarded Stop and reconnect. Shared selectors have a checked immutable source manifest. Broader live provider combinations still need qualification; the standalone Claude child and observed Codex parent are narrower cases. Record real-device navigation, frame time, memory and thermal
observations under an explicit workload before claiming a phone improvement.

Evaluate optional classification against held-out tasks with independent result
checks and total attempt cost. Keep reference benchmarks and observed provider
usage separate. Confidence values require calibration on the target task; they
are not a promotion rule by themselves. The existing advice tool remains optional.
