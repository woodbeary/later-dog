# Engine placement and native shell guarding, 2026-11-08

## Completed guard and baseline triage

The home shell guard previously covered Claude only. Native Codex Full Access does not request shell approval, so guarding approval requests could not prevent a heavy command. The runtime now installs a root-managed Codex PreToolUse hook in /etc/codex/requirements.toml. The driver gives each guarded turn its scoped hook URL and a private token file, using the existing hook endpoint and heavy-command classifier. It does not change accounts, models, effort or approval policy. The first recognized heavy command is denied with run_on_computer guidance; a repeat within thirty minutes allows the existing fallback.

The implementation uses the documented [native Codex hook interface](https://learn.chatgpt.com/docs/hooks), including managed requirements and Bash coverage for unified exec. It does not bypass trust for project or plugin hooks. The helper remains bounded and fails open when the home cannot answer, as the existing Claude helper does.

The pinned Linux Codex in laterdog-cloud-home:latest passed scripts/verify-codex-heavy-guard.mjs with the real managed requirements and packaged helper: two native hooks, one denial before execution, and one repeated command executed under Full Access. A loopback synthetic Responses service supplied the commands; no live provider, account credential or live conversation was used. The fixture checked the marker was absent after denial and present after the repeat. This qualifies the native hook mechanism, not a production provider turn.

Before the last driver regression was added, 245 tests passed across the driver, helper, classifier and environment preparation. The final driver and environment-preparation rerun passed 231 tests, including the added check that a guarded native Full Access turn receives its scoped hook file and never puts its authority on argv. Server typechecking and focused lint passed. Comment and brand/link checks passed 13 tests.

The twelve earlier server failures were triaged against current main:

- Six managed-desktop-cleanup fixture failures: its VM context omitted the imported endsSentWork helper, and its source extraction accidentally included the newer provider reload scheduler. The fixture now supplies the real helper and stops at the reload function boundary. All 17 cleanup tests passed.
- Four cloud-start fixtures: their 20/30-second waits expired while production deliberately retried passing startup failures for up to 150 seconds. The fixtures now set a one-second startup budget and retry pause, making their immediate permanent-refusal scenarios deterministic without changing production timing. The place, surface-pin and cloud-start checks passed 17 tests.
- Usage-ledger prompt text and computer size projection: already fixed by merged main. The owner/phone usage fixture and safe computer identity/size checks passed in the initial five-file rerun. The original usage-ledger failure was a real prompt-retention regression; it is not classified as an environment failure.

The original five-file set comprised 47 tests. Its initial rerun passed 43, with only the four cloud retry waits remaining; the corrected cloud fixtures passed afterward. None of the twelve failures is being dismissed as environment-only. A fresh full server run is in progress; no full-suite success is claimed here.

## Read-only baseline

An authenticated read using the desktop app's existing owner session via scripts/cloud-access.ts returned health and storage HTTP 200 at 2026-11-09T02:58:31.733Z. Disk free was 2,404,110,336 of 19,228,708,864 bytes. Available memory was 10,794,643,456 of 12,808,597,504 bytes. The log-only archive was enabled, with zero files/bytes since restart. This is a baseline, not a measurement of engine migration savings.

## Engine relocation

The engine transport and workspace/session continuity work is still in progress and is not yet deployed. A fresh run_on_computer probe succeeded on the dog's cloud computer with Linux and Node v24.22.0. No per-dog production engine placement or RAM saving is claimed yet.

Session/provider archiving and archive deletion remain off. Other dogs were not started and existing worktrees and diffs were preserved.
