# Cloud workspace scaling and model line release, 2026-11-08

## Published changes

Phone main `404b821ecbb6732f85f59d5a09db1958a7990569` was published from Jacob's Mac as beta OTA group `bed5951a-9d95-4f93-b209-79c9fd294527`, for iOS and Android, runtime `1.0.1`. EAS update:view confirmed the source commit and both platforms at 2026-11-09 02:25 UTC. The release passed pnpm verify: 1,777 tests, typecheck, iOS export and native configuration; lint had 52 existing warnings. Its native fingerprint matches Build 9 (`945b9c2c…`) and includes the previous beta's `0c0feb1` ancestry. Notes are in phone PR [163](https://github.com/woodbeary/later-dog-phone/pull/163), commit `f000e80`. That notes PR remains open. Later beta publications have superseded this group: the read-only EAS list at 02:25 UTC reports `336047c1-f650-4353-8287-228882f44069`, from `9312d21`, as newest. Git ancestry confirms that newest beta's `9312d21` includes the model-line fix at `404b821`. This record does not republish or roll back that update.

Desktop `ee1fa656138eb68855af544ba8b0ff387dcd3654` fixes the same account handoff explanation. The selected ChatGPT account was off; the home ran the chat on Claude's account named jacob, while the model line omitted the cross-engine explanation. The line, accessible label, tooltip and account menu now identify `jacob (Claude)` and explain the move. The focused routed-line, ModelPicker, no-comments and brand/link checks passed again after the restart: 84 tests in four files. Earlier focused lint, typecheck and locale checks passed. Installed desktop appearance has not been verified in this release.

Cloud change `5027f5692374414d28ef33355647acef206d5598` adds reuse of a successful same-lockfile node_modules on the dog's computer across new session folders, and a Claude PreToolUse shell guard that directs heavy work to run_on_computer. A repeat of the same command within 30 minutes permits a fallback. This is a workspace setup and heavy-command stage; it does not relocate engine processes.

## Checks and deployment

The rebased change passed typecheck, locale validation and six focused test files (98 tests). The full server run had 706 passing files, two skipped files and five failing files: 9,544 passed, 12 failed and 20 skipped tests, plus five errors. Running the five failing files against the unchanged baseline reproduced all 12 failures and five errors (35 other tests passed). Those baseline failures are in managed-desktop-cleanup, place-view, surface-pins, usage-ledger-api and cloud-computers. The full suite is not green.

A clean archive of main at `5027f5692` built the cloud-home base image on the Mac, targeting Linux amd64. A full Wrangler deploy completed with exit 0, published Worker `be2b07aa-168b-45e1-a841-804170ab8c62`, and updated both production runtime applications:

- standard-1 image digest `sha256:a0d4db92e05c4d3a404d575c4c5d9cea34d689554eb4bbd3c26a986fe48fa21c`;
- standard-4 image digest `sha256:ea34a2655bc591cdaf1e4bdcf7dc10ad5f9776124c81f5296e29f20ee17f570b`.

The post-restart read-only Wrangler deployment list reports a subsequent active Worker version `474562b8-2493-4edf-9b0d-a381662cb693` at 100%, uploaded at 02:08:44 UTC. The runtime application has one running large-home instance in sea01, container version 50, created at 01:59:58 UTC. No additional deployment was performed during this verification.

## Packaged Linux setup smoke

The cloud computer service timed out, so the final check used an isolated Linux amd64 container on Jacob's Mac, with the deployed base image and its packaged computer-runs implementation. At 02:27:27 UTC, Node 24.22.0 generated a pnpm lockfile for a local fixture dependency, installed it offline with the frozen lockfile, copied the project into a new session folder, and loaded the dependency there without installing again. The result explicitly reported package reuse and brought back only report/result.txt. No node_modules returned to the home. A third session with a changed lockfile received no packages. All commands exited 0. This checks real pnpm files and Linux copies; it does not qualify the live computers service or engine placement.

Reproduce after building the cloud-home image from this commit:

```sh
docker run --rm --platform linux/amd64 --entrypoint /bin/bash \
  -v "$PWD/scripts/verify-computer-setup.mjs:/app/scripts/verify-computer-setup.mjs:ro" \
  -w /tmp laterdog-cloud-home:latest -lc 'node /app/scripts/verify-computer-setup.mjs'
```

The smoke creates a temporary synthetic project inside the disposable container and uses no account or credential.

## Live confirmation

At 02:22 UTC, this home reports `/app/cloud/build` = `5027f5692`. Its running server entry is `/app/dist-server/index.js`; the packaged computer-runs module includes setup reuse and the packaged index includes the PreToolUse guard. This confirms packaged activation, not a live provider qualification.

Authenticated GETs using the desktop app's existing owner session via scripts/cloud-access.ts returned HTTP 200 for health and storage at 02:22:27 UTC. No token was printed. Disk free was 2,462,396,416 of 19,228,708,864 bytes; available memory was 10,719,383,552 of 12,808,597,504 bytes. Storage low was false. The log archive was enabled, with zero files/bytes and no scan yet since this server restart. These reset counters do not measure this release's disk savings.

Session/provider data, tool-result and checkpoint archiving remain outside the automatic log scheduler, whose eligible paths remain event/native logs only. Archive deletion/GC remains off. Snapshot-store garbage collection is a separate existing mechanism.

## Remaining work

Engine processes still run on the shared home. Remote engine transport, workspace migration and its recovery/authority checks remain unfinished. Codex shell commands are not covered by this Claude hook. This release does not establish per-dog engine isolation or a production concurrency capacity. No other dog was started for this verification, no login/model/effort was changed, and existing worktrees and diffs were preserved.
