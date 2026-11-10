# Phone chat opening and Run Check, November 10

## Measured baseline

Jacob ran Run Check at 10:01 Pacific on Build 9, iOS 26.6.1, six chats.
The report was read from phone-crashes.json, update
01a1c699-37f0-75e9-8771-aa4296c800dc.

| Reading | Filtering off | Filtering on |
| --- | --- | --- |
| Switches | 26 | 24 |
| Total renders | 976 | 891 |
| Renders per switch | 37.5 | 37.1 |
| Dropped frames | 900 | 868 |
| Longest stall | 459 ms | 1710 ms |
| JS heap | 140 MB | 144 MB |
| Idle home renders | 87 | 23 |
| Phone-skipped deltas | 0 | 0 |

The historical report counts all selected component renders, including initial
mounts. It does not identify the phase that stalled or count incoming stream
deltas. Zero skips therefore cannot establish that the filter failed, nor
whether there was streaming. A home that filters off-screen deltas can also
prevent them from reaching the phone in the first place.

## Code observations and changes

Chat and its nested hooks subscribed to the whole store. The message box did
so only to obtain upload actions. A selected store boundary now invalidates
for that chat's messages, progress, status and relevant roster changes, with
stable action functions forwarding to the latest store. Other chats' deltas
and activity do not invalidate it. Sender model labels also retain their
identity when the labels have not changed. Header and composer view props
keep current callbacks without rebuilding unchanged view trees.

Message rows compare their content and props. The inverted FlatList already
existed; its initial and subsequent batches and render window are now bounded
explicitly. Cached thread data is still used immediately.

The width check lexed full replies, even when their visible body was folded,
and the body lexed that Markdown again. A folded preview previously chunked
the entire reply just to keep the first chunk. Preview extraction now stops
after its first chunk; width checks inspect that visible preview. A bounded
LRU shares parsed Markdown across width checks, body rendering and chat visits.
Usage readings younger than five seconds are reused during rapid navigation;
manual refreshes, reset refreshes and resumed-app refreshes bypass that guard.

Run Check still uses the same six-chat, switching and idle passes. Its labels
now say filtering off/on: that switch compares streaming policy, not old and
new UI code. Reports include incoming and watched delta counts, whether home
filtering is supported, and timings for Markdown, transcript derivation,
saved-copy serialization, React commits and chat layout. Timings distinguish
these operations from the independently measured frame stalls; they do not
prove a stall's cause until a real-phone report is read.

POST /api/phone/perf saves bounded, validated reports in phone-perf.json with
mode 0600 and a 50-report cap. GET lists them. The phone no longer disguises
an unsupported performance endpoint as a crash; it keeps the copied report
instead. The isolated HTTP fixture proves this path writes no crash file.

## Verification limits

Unit fixtures cover unrelated-stream isolation, live action forwarding, own
message and reaction invalidation, cache reuse and eviction, bounded previews,
usage freshness across accounts, and delta/timing diagnostics. The HTTP fixture
runs a separate temporary home and never writes to production data.

The real-phone target remains under five renders per switch and no stall over
200 ms. No post-change phone measurement or causal attribution of the 1710 ms
stall is claimed here. Publication and another Run Check are required.

## Release checks

Phone implementation: f810932ab93c5add761fc8ed51ca2c6ff0614b60.
All 1870 tests passed on the cloud computer and again on Jacob's Mac.
Typecheck passed; lint reported zero errors and 52 existing warnings.
The iOS production export passed on the cloud computer. The Mac native
introspection retained the microphone permission.

Home metrics implementation: 72380c9, released from 46ff07acc after merging
current main. Typecheck and lint passed. The merged account/metrics checks
passed 140 tests with one stale manual-choice expectation; updating that
expectation to require byHand:true produced 34 passing targeted tests.
The previous Google/vault/catalog merge checks passed 56 tests.

Published home bundle:
d5bb6aa1c9b95e9dc141f9a138bda98367c65212601ae6888b35abdebe017107.
The downloaded index.js matches the Mac artifact byte for byte, SHA-256
c857d90ce11652d6098e285947265f56d3ee251abab49d1ac9f2b6b4584d3a04.
The home activated this exact bundle. An authenticated GET /api/phone/perf
returned 200 with zero reports. A fresh iPhone Run Check is still required.

Performance beta c6c8cf77-483c-4eed-978f-c7faa5cc0d89 is published from f810932.
Build 9 fingerprint 945b9c2c06f193d0bc54a8c9b0740e75b799c93e matches.
The actual downloaded iOS asset (update 01a1c72c-b396-7913-a675-9efd0c367f00,
5867356 bytes) matches the Mac export, SHA-256
ea8c23678fe817f4ab07b793549059b639dd3d037915e05e5888535a7c37d888.
Rollback group: 4c72c061-661e-4d64-b381-c1d5c6c02933. Jacob has been asked to
reopen the phone and run the same check. No post-change numbers are claimed.
