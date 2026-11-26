# Continuing unfinished work

Teammate messages with `reply: "none"` are saved as context. They do not start a recipient turn, occupy its work queue, wait for an answer or wake the sender. The recipient receives the pending notes together at its next real turn. Use the default `reply: "result"` when a teammate must start work and return an answer.

Pending context is durable in `room-handoffs.json`. A transcript row retains the sender and request ID. The complete batch is acknowledged after its transcript writes succeed; retrying placement after a restart does not duplicate a stored row. Current membership and peer permissions are checked again before placement. Never-started queued notes from an older home migrate to this path; already-started work retains its existing lifecycle.

A recognized turn size, context or tool limit continues automatically when the chat's saved plan has unfinished steps and no human input is pending. Direct conversations and group conversations keep the same request, chat, speaker and coordination ownership. Continuation reads the saved plan and workspace notes and checks current state before repeating actions. Usage/account recovery keeps its separate existing path.

`plan-continuations.json` keeps the recovery obligation through successor setup and across a home restart. Stop, a newer queued human request, an unanswered card, a removed task or revoked route cancels the continuation. Pending continuations remain working on the wire; they do not count as an active provider process for admission. A successor still has to pass the ordinary model, approval, tool and computer checks.

Continuation has no terminal attempt count or unchanged completed-step count. Attempts and unchanged completed-step counts remain durable diagnostics; they never end the authorized work. A new request resets the diagnostics.

## Checks

The isolated real-server fixtures use scripted engine processes and disposable data. They cover direct and group limit endings, delegated results, saved FYI receipts, idle/busy recipients, ordinary work order, waiting cards, Stop, queued human precedence and persistent continuation before verification completes. Unit checks cover persistence through successor setup, duplicate events, generation mismatch, admission retry and repeated limits across restarts.

Baseline failures were captured on `4efafe4ce938f485e23bdbd531c184f246249c5c`: FYIs made an idle recipient busy and occupied queue positions; direct and delegated limit endings stopped after one turn. A separate group fixture failed to reach its successor before group support was added. These checks exercise the home's recovery decisions and native protocol frames. They do not qualify an injected failure against a live provider.

```sh
pnpm exec vitest run server/laterdog/plan-continuation.test.ts server/laterdog/plan-continuation.e2e.test.ts server/laterdog/group-plan-continuation.e2e.test.ts server/laterdog/teammate-context.test.ts server/laterdog/teammate-context.e2e.test.ts
pnpm gate
```
