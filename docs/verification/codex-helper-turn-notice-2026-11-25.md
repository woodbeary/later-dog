# Native Codex helper checkpoints

Coordinated Codex helper turns now receive the existing checkpoint notice after 80 unique completed tools or 160,000 context tokens, and again after ten more tools. Direct owner turns keep their existing behavior. This is an advisory notice; it does not create a question card, persist a chat bubble, cancel the turn or queue a replacement request.

The counter binds to the app turn ID returned by the still-current dispatch generation. Provider start events cannot establish that binding. Completions must match the selected Codex instance, thread and bound turn, carry an item ID, and be nonsynthetic. Duplicate item IDs count once. Native turns do not also count PostToolUse hooks. Delivery uses the adapter's immediate guarded turn/steer call with its captured expected native turn ID; cancellation prevents it from reaching a replacement turn.

## Evidence

Five actual loopback home/coordinator/app-server IPC cases cover notices at calls 80/90, the 159,999 to 160,000 token boundary with ten-tool spacing, direct owner turns including the main dog, and cancellation followed by an owner replacement. The three helper cases fail before the production repair while both owner controls pass. Notices appear in the captured turn/steer RPCs, with no persisted notice or card.

Review also reproduced a stale same-instance start binding the initial implementation before the current dispatch returned. A targeted regression fails before the binding correction. All 359 related checks across 13 complete files pass after it, with zero skips. Both complete Bun 1.4.5 type graphs pass (1,122 frontend and 1,754 server files), as do lint with zero warnings/errors and the diff check. The isolated dependency install initially left a Bun stub after scripts were ignored; normal frozen lifecycle installation and a real version check corrected that validation environment. The earlier failure remains in the external evidence.

Raw red/green logs, source hashes, dispatch/steer references and IPC receipts are retained in the overnight Lead evidence under checks/codex-helper-budget-20261125. This proves local application and provider-protocol behavior using the scripted app server. Live provider acceptance, context-cache retention and compaction behavior are unobserved. The complete combined gate and release remain required.
