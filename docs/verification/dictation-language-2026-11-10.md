# Shared dictation language, November 10

Jacob reported English dictation containing unexpected Chinese text. The
recording has not been replayed, so the exact cause of those words is unproven.

Code evidence: phone whole-note and streamed requests omitted a language;
desktop used navigator.language. With no language, the home omitted the
provider hint. The home now defaults to English and persists the independent
dictationLanguage setting (en or auto), exposed in GET/config events and editable
from Settings on phone and desktop. UI language remains a separate setting.
Desktop now lets the home select the dictation language instead of deriving it
from the browser locale. Old explicit two-letter API hints remain supported.

Whole-note and streaming paths send language_code=en to ElevenLabs/the included
service, or language=en to xAI. Auto-detect intentionally omits the hint. Stream
sessions preserve this choice even when it is the empty auto-detect sentinel.
The included computers Worker already forwards a supplied language to Scribe,
Nova-3 and Whisper Turbo, so this change needs no Worker/image deployment.

Sources checked: [ElevenLabs](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)
accepts language_code; [xAI](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
accepts language; [Whisper Turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
supports language. These are hints, not a guarantee against transcription errors.

Verification: typecheck and lint pass; 281 of 282 focused tests passed. The
one existing failure is cacheUntilConfigChanges' chmod-000 unreadable-file case.
An independent cloud probe showed uid 1000 could still read a freshly created
mode-000 file, explaining that fixture limitation. The existing expectation
was retained. A clean baseline archive attempt failed because transferred Git
objects were incomplete; that failed scratch directory was retained.

The new isolated HTTP config round-trip passed. All 157 no-comments/store
checks and locale validation passed. Phone typecheck, six focused tests and
lint passed (zero errors, 52 existing warnings). Phone setting commit a6f4804
is on main. Mac verification initially timed out without starting (confirmed by unchanged
HEAD and absent logs). After reconnection, all 215 home config/transcription
checks passed on the Mac, including the permission case. The phone's Mac
typecheck and lint passed; its full suite was still running at the last readable
log. Later Mac command_output and log-read calls timed out, so the full suite's
final result and native introspection remain unconfirmed. Do not duplicate the
running command 2012cfe6-fc32-4db3-a568-24ff73d70c0f; inspect it on reconnect.

Home source ad16de8b3 published bundle
d6a3bf178ac322f29c41a3f7735d3b6c64312305390cb06b203866569dc3df10.
Downloaded index.js matches the Mac artifact, SHA-256
a6f0f8a5ece9cb890d9e911e0d0bddfd7db34de4049cfcad728e5d017ea9b9e3.
At 20:53 UTC the home still ran performance bundle d5bb6aa1c9b95e9d,
so dictation activation is pending its safe switch. No forced restart was used.
The phone dictation OTA has not been started. Its release needs the existing
Mac verification result, native check and Build 9 fingerprint gate before
publication. The current published beta is the performance release
c6c8cf77-483c-4eed-978f-c7faa5cc0d89; that is the next rollback target.
The desktop source change is on main for the next desktop release.

Physical phone and installed desktop dictation have not been verified by these
source fixtures. The reported English/Chinese recording was not replayed.


## Activation receipt

The home subsequently activated the published dictation bundle. PID 165452 was
observed running /tmp/laterdog-dev-server/d6a3bf178ac322f2/index.js, with health
200 and the exact artifact hash recorded above. An authenticated GET /api/config
returned 200 and dictationLanguage:en. No live setting was changed to test it.
The combined phone release is pinned to main commit
7c2b0fba7c75515967eee3c9de8d6bb2dc421305, which includes a6f4804 and the larger
model labels. Its publication receipt is still pending.

## Phone publication receipt

The combined phone beta is published as aae01c1a-cd3a-48d9-b0be-50a7bd6a72f5,
source 7c2b0fba7c75515967eee3c9de8d6bb2dc421305, runtime 1.0.1. The exact
Build 9 fingerprint matched. The actual downloaded iOS update
01a1c76e-c273-7920-9206-9a40275fb56a matches the Mac export (5868960 bytes),
SHA-256 c1a80052e6f3f4bfba8ff5202111e7aedaddbceb168eb9bfcd7a4dba6607431d.
The publishing script exited zero. Rollback is performance beta
c6c8cf77-483c-4eed-978f-c7faa5cc0d89.

The earlier Mac search import timeout passed unchanged on retry, 8/8. Final
Mac typecheck/lint passed; a redundant full Mac rerun was stopped and is not
counted as passing. Pane supplied the 1871-test product-source run and final
five model checks after the source-only test assertion update. No additional
Pane test rerun was needed for publication. Physical dictation and a fresh
real-phone performance check remain unverified; desktop source is ready for
its next binary release.
