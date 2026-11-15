# Item 42: long single turns

Read `/Volumes/fable-native/briefs/wave2/LEAD.md` first: it says how you work. Lane name `short-turns`, branch `fable/short-turns`.

## What the person sees today and should see instead
Nothing on screen: the cost. On 14 November each helper dog did its whole lane in one turn, growing from about 35K to 220K to 440K tokens of context without compacting and re-reading that context on every step. One helper polled a test run about fourteen times at 440K tokens; one read the same large server file fourteen times. The result was a very large use of the owner's AI allowance for little work. Wanted: a dog waits for a job with one call, reads parts of files, and compacts at a natural boundary.

## Where it lives
- What dogs are told: `server/laterdog/dog-guidance.ts` (the fixed standing instructions; a grep of the combined branch finds no line about waiting with one call or reading in parts), `server/laterdog/helper-contract.ts` (what a helper's report looks like and when it stops).
- Waiting: a dog waits on dogs with `wait_for_conversation` (`server/laterdog/bridge.ts`); on its computer, `run_on_computer` (`server/laterdog/computer-run-route.ts`, `computer-runs.ts`; it times out while the computer is still working, see item 36). Find whether a job can be waited on with one blocking call that returns when the job ends or a limit passes; if not, that is the build.
- Compaction: `server/laterdog/native-compaction.ts`, `compaction-row.ts`, and the driver `server/drivers/claude.ts` (the engine compacts its own chat; the home folded at 160,000 of 200,000 before).
- Measuring a turn: the usage ledger and the context view (`GET /api/threads/:id/context`, `shared/context-breakdown.ts`); a measuring script exists for the instructions: `scripts/measure-dog-prompt.ts`.

## What to build
1. Measure first, on fixtures: how a fake-engine dog that polls a job and re-reads a file grows across steps; write the numbers.
2. One call that waits for a job (or a run of jobs) until it ends, with a bounded wait and a plain result; the tool's description says to use it instead of polling. Test: a job that ends after N seconds is waited on in one call where polling took many.
3. A short rule in the fixed instructions, in later.dog's own words, one sentence each: wait with one call; read parts of a file, not the whole file again; when a lane's step is done and the context is large, compact before the next. Measure the growth of the instructions (`scripts/measure-dog-prompt.ts`) and keep it small; update `docs/verification/harness-and-instructions.md`.
4. A helper stops and reports after a bounded number of tool calls or tokens in one turn and says "partly done", so the coordinator hands the rest on in a fresh turn (the report contract already has done, partly done, blocked: read `helper-contract.ts` before adding anything).

## Done means
Numbers before and after on the fixture, tests that fail before each change, an independent review at the exact commit. The whole gate is run by the maintainer.

## Out of scope
Changing the engine's own compaction, any real engine run, the account and limit logic (items 30 and 31).

## What only a real home or phone can prove
That a real dog on a real engine follows the rule (the rule is advice, not a mechanism): compare a real helper's context growth over a lane with and without it on an isolated server, using a real engine only if the maintainer runs it.
