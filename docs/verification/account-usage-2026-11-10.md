# Account allowance and context reporting, November 10

Fresh account usage now reconciles saved session and weekly quota holds. A hold
records the provider reading at refusal, so an unchanged lagging reading does
not repeatedly reopen a refused account. Legacy holds can recover from a newer
positive reading. Failed, old, still-exhausted, setup and model-specific readings
retain their existing restrictions.

Codex credit balances are shown in the account menu, switcher, Settings and usage
details. Included allowance and paid credits remain separate quantities. Balances
are formatted as credits, without assigning a currency value.

Claude context reporting uses the parent model's native context-window receipt.
The Fable 5 family has a one-million-token fallback. Existing inferred 200K Fable
records are corrected in the API projection; an explicitly reported native 200K
window remains authoritative, including after restart. Older usage refreshes can
no longer replace a newer reading in the server cache or renderer store.

## Verification

The focused account-battery, model-window, store and usage-view suite passed 206
tests. Native Claude receipt and child-isolation checks passed three selected
tests. Account menu, switcher, Settings, context display, provider parser and
source-policy checks passed 130 tests; the initial brand scan exceeded its
20-second limit. A subsequent run with a 180-second limit passed the brand check
alongside refresh-order and account-view checks, 93 tests total.

`server/context-compaction.e2e.test.ts` launches the canonical isolated server and
fake engine, sends through `control-laterdog`, restarts the fixture and reads the
real HTTP task projection. Both selected cases passed: 244,210 context tokens
with a reported 1M window, and the same count with an explicit 200K window. The
initial cold launch exceeded the harness's startup deadline; the repeat passed
after concurrent compiler processes were stopped. Evidence remains at:

- `/var/folders/yw/5wnl09b174d04gswmppq4pl80000gn/T/laterdog-verification-evidence/server-1794372688899-73037.log.context.json`
- `/var/folders/yw/5wnl09b174d04gswmppq4pl80000gn/T/laterdog-verification-evidence/server-1794372730062-73037.log.context.json`

The quota correction was committed as `f4b30d15e`, applied to the Dev checkout as
`164496e6d`, and published through the existing Dev code path as bundle
`28084b0d2b4776496565a96567a9ef02a4befd259dd67f15c9776074dc369044`.
At 04:55:28 UTC on November 11, the owner's home returned PID 56246, Jacob's
provider reading showed 98% session and 100% weekly allowance, and the saved
quota hold was absent. This is account-availability proof; no live native turn
was sent as a test. No dog received a message or a queued instruction.

The credit and context presentation checks use synthetic provider data. They do
not qualify a new desktop installer or a native provider's quota enforcement.
