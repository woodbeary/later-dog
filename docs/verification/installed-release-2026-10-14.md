# Installed release verification — 2026-10-14

## Scope

later.dog 0.3.28 for macOS, downloaded from the GitHub release the way a new user gets it, on an Apple-silicon Mac. Both runs used the sealed scripts: a temporary home, `CFFIXED_USER_HOME`, and for the install check a sandbox that cannot read or write the Mac's own later.dog data or sign-in stores. The free trial was a real one on production `cloud.later.dog`, granted to the copy with the service owner's key and ended when each run stopped. No Claude or ChatGPT account was signed in. The owner's own later.dog was not running.

Before the release, every check on the release commit passed in GitHub Actions: lint and source checks, all four test shards, the renderer tests, and the Worker and supervisor builds.

## Observed results

| Check | Result |
| --- | --- |
| Release assets | `later.dog-macOS-arm64.zip` matched `SHA256SUMS.txt`, and the updater's `latest-mac.yml` sha512 matched the zip. |
| Signature and Gatekeeper | `codesign --verify --deep --strict` passed; `spctl` accepted the copy marked as downloaded as Notarized Developer ID (The Interpreting App, LLC); the stapled ticket validated. |
| First start | The app came up sealed; its server answered `/api/health`, and its window loaded later.dog. |
| Read Aloud | From the copy's own window, `/api/tts/speak` answered 200 with 8,784 bytes of `audio/mpeg` through the included voice. |
| Dictation | From the copy's own window, a 76 KB WAV of "Hello later dog, please say hi back." came back from `/api/voice/transcribe` as exactly that text, through the included voice. |
| In-place update 0.3.27 → 0.3.28 | A sealed 0.3.27 found and staged 0.3.28 by itself. The installer waited for the copy to quit and did not relaunch it, installed on quit, and the updated copy reported 0.3.28, still Notarized Developer ID. All 33 data files from before the update were still there. |
| Real data | After each run: no file changed in the real later.dog folders, the copy's trial was ended (HTTP 200), its temporary home was removed, and no installer job was left behind. |

## Not covered

A dog's reply on a provider, the tour and the composer were not driven this time; the 2026-10-12 record covers them for 0.3.24. A Claude or ChatGPT account, the phone, and later.dog Cloud sign-in were not part of this run.
