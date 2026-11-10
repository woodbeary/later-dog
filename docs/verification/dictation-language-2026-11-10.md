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
is on main. Mac verification was requested but its start timed out; the Mac
then reported disconnected. Its command outcome must be inspected on reconnect
before retrying. No dictation OTA or home release is claimed yet.

Physical phone and installed desktop dictation have not been verified by these
source fixtures. The reported English/Chinese recording was not replayed.
