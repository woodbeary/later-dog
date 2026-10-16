# Push an update

The public macOS update is GitHub's **Latest** release of `woodbeary/later-dog`. Publishing it reaches installed apps: they check at launch and hourly, download the ZIP, and offer **Restart to update**. The DMG is for new installs. The supported public build is macOS Apple silicon.

Build a candidate first. A candidate workflow has read-only repository permissions and cannot publish a release. Promotion uploads the exact accepted bytes; it never rebuilds them.

## Prepare the candidate

1. Set a new stable `version` in `package.json` and add its dated section to `CHANGELOG.md`. An `unreleased` heading is refused.
2. Complete the change's isolated verification and independent review. Freeze the reviewed PR head SHA and keep a branch pointing to it for candidate builds. Before promotion, that PR must be merged and this exact head must be reachable from `main`; a new merge or squash SHA does not inherit the old head's acceptance.
3. Request a candidate:

   ```sh
   gh workflow run macos.yml --repo woodbeary/later-dog --ref FROZEN_RELEASE_BRANCH -f release_tag=vX.Y.Z
   ```

4. Verify the run's source SHA. Download its `later.dog-release-candidate` artifact:

   ```sh
   gh run download RUN_ID --repo woodbeary/later-dog --name later.dog-release-candidate --dir /tmp/laterdog-candidate
   ```

The artifact contains the ZIP, DMG, `SHA256SUMS.txt`, final `latest-mac.yml`, `NOTES.md` and `candidate.json`. The manifest pins the source commit, workflow run, version, signing identity, accepted app/DMG notarization receipts and every file's hash. It is not an update feed until promoted.

A tagged candidate requires all Developer ID and notarization credentials; it refuses the legacy self-signed or ad hoc fallback. Both the app and DMG must pass notarization, stapling and Gatekeeper checks. Untagged pushes still produce development packaging artifacts, which are not promotable candidates. Preview tags no longer publish from this workflow; use the candidate artifact for testing. The separate Dev app remains on its own rolling feed.

## Verify before distribution

Run the sealed checks with the candidate directory, following [the installed-app safeguards](../verification/README.md#installed-app):

```sh
scripts/sealed-installed-app.sh /tmp/laterdog-candidate
scripts/sealed-update-check.sh vPREVIOUS.VERSION 19345 /tmp/laterdog-candidate
```

The fresh check verifies ZIP and DMG hashes, signatures, notarization and Gatekeeper, then opens a disposable profile. The upgrade check serves the accepted candidate ZIP only on loopback, directs the older sealed app to that feed, installs on quit without relaunch, and reopens the same temporary profile. Public Latest is unchanged. Never use **Restart to update** inside the sealed copy: Launch Services would escape the temporary home. Never give that copy a task on this Mac; it inherits Accessibility and Screen Recording grants.

Also verify the authorized real account, its conversations, both native providers, and the physical iPhone against the candidate combination. Freeze the phone source SHA, app version, Expo runtime version, build number, EAS build ID and App Store Connect build ID before acceptance. Freeze the Cloud image's source SHA, immutable `sha256:` digest and exact Claude/Codex versions from its build and runtime evidence. Verify that image in an identified staged test home. A fixture or simulator pass cannot qualify real-provider or real-device behavior. Keep account details and credentials out of public release notes.

Keep Expo development verification separate from verification of the exact TestFlight build. Verify the actual account, workspace and conversation identity on both surfaces. The desktop/mobile compatibility receipt must cover both apps against the accepted Cloud image, including the frozen phone, candidate desktop and currently distributed app versions; do not assume everyone updates together. Cloud home remains the canonical workspace owner. Independent review must name the desktop, phone and Cloud source SHAs. A changed phone runtime, build, Cloud image or provider version invalidates the affected acceptance receipts.

### Stage Cloud home without updating every account

The home Worker has three independent container applications: `CloudHomeHost`, `CloudHomeHostLarge` and `CloudHomeHostCandidate`. The candidate is a release lane, not a different workspace. `CANDIDATE_HOME_ACCOUNTS` is an exact comma-separated account allowlist and defaults to empty. It takes precedence over the size allowlist; removing an account returns it to its original standard or large lane. Keep real account IDs and checkpoint selections in private deployment configuration, never in the repository. The existing large class keeps its existing purpose.

Build one Cloud image at a frozen source SHA through `cloud-home-image.yml`. Record its registry digest and copy those exact bytes to Cloudflare's registry when needed; do not rebuild between stages. In the private configuration, set the candidate's `image` to `registry.cloudflare.com/ACCOUNT/later-dog-home@sha256:DIGEST` and `CANDIDATE_HOME_IMAGE_DIGEST` to the matching `sha256:DIGEST`. Record the current standard and large image digests in `HOME_IMAGE_DIGEST` and `LARGE_HOME_IMAGE_DIGEST` for rollback. These variables are expected values, not runtime attestation: verify the actual instance image through Cloudflare and the source/provider versions through build and runtime receipts.

Preserve the exact deployed standard and large configuration while introducing or updating the candidate application. In particular, do not replace their image references with stale checked-in references, or switch their tags to digest references during the canary step. A full deploy creates/updates the candidate application; it must show no effective image/resource change for either existing application. For later Worker-only routing/checkpoint changes, use `--containers-rollout=none`; this flag neither creates nor updates candidate images. A normal production image deploy is an application-wide rollout, even when configured with a small percentage. It is not an account selector.

First stage and verify the candidate against the separate test Worker, `wrangler.test.json`, its `*-hometest.later.dog` host suffix and `laterdog-homes-test` bucket. `scripts/test-home.mjs` addresses only `test-*` accounts. The candidate path needs the checkpoint below in the test bucket too. Confirm the observed instance digest before provider, Expo and phone testing. After those checks, enable only the authorized real account on the production candidate lane. The canonical origin, account, machine ID, sessions and R2 state prefix remain the same.

### Full-state checkpoint required for a lane change

The candidate must not restore until every other possible owner has released the home and its container has stopped. All owners must support release protocol 1; a running Durable Object on older Worker code blocks the handover until it has stopped and refreshed. Routine alarms and stale starts cannot reacquire a released owner. A new checkpoint is required when returning from a candidate to a stable lane. Once a lane is accepted, ordinary sleep/wake cycles reuse its acceptance until that owner releases the home.

Process exit alone is not checkpoint proof. The 0.3.41 runtime catches snapshot errors and can exit after its final-save deadline. Workspace backup export also excludes provider authentication, sessions and other owned connection state. Neither qualifies a full-home checkpoint. Do not declare either complete or use it to fabricate the receipt below. Production SSH was not enabled when this lane was prepared; the existing test-home SSH helper selects a test instance and is not a production maintenance path.

A privileged maintenance procedure must first verify the exact account, canonical instance and source image, quiesce all writers, and establish a complete durable `/data` snapshot with no unsaved files. Its saved evidence must cover provider authentication, sessions, workspace and conversation identity, the normal runtime exclusions of transient caches/locks, and the successful checkpoint after quiescence. Preserve the exact manifest and every referenced content-addressed blob under a separate private R2 prefix, outside the runtime's `homes/` garbage collection. Preserve the evidence bytes as `evidence.json`. No compatible full-state maintenance proof means the account canary remains blocked; changing the allowlist does not waive this gate.

Under `checkpoints/CANONICAL_STANDARD_DO_ID/CHECKPOINT_ID/`, retain `manifest.json`, `blobs/HASH` for every referenced chunk, `evidence.json`, and this `receipt.json`:

```json
{
  "schemaVersion": 1,
  "accountId": "PRIVATE_ACCOUNT_ID",
  "machineId": "hCANONICAL_MACHINE_ID",
  "stateHome": "CANONICAL_STANDARD_DO_ID",
  "targetLane": "candidate",
  "sourceImageDigest": "sha256:SOURCE_IMAGE_DIGEST",
  "targetImageDigest": "sha256:ACCEPTED_CANDIDATE_IMAGE_DIGEST",
  "manifestSha256": "SHA256_OF_EXACT_MANIFEST_BYTES",
  "evidenceSha256": "SHA256_OF_EXACT_EVIDENCE_BYTES",
  "proof": "quiesced-full-data",
  "complete": true,
  "completedAt": 1792108800000
}
```

Use `node deploy/laterdog/home/checkpoint.mjs --directory PRIVATE_CHECKPOINT_DIR` to verify retained local bytes before upload. It streams and hashes every referenced chunk. Its input `maintenance.json` carries schema version 1, the account/machine/home/lane/image/time fields shown above, `scope: "full-data"`, `quiesced: true`, `workerReleaseProtocol: 1`, an empty `unsaved` array and `quiescenceEvidenceSha256`, which must match the retained `quiescence-evidence.json`. These are actual privileged maintenance observations, never assertions inferred from process exit. Add `--write` only after verification to create new private `evidence.json` and `receipt.json`; existing files are never overwritten. The tool does not quiesce a home, take a snapshot, access Cloudflare, or establish live provenance on its own.

Local validation alone does not prove the retained R2 upload. Before authorizing a lane change, read back the retained manifest and every blob from the exact private R2 prefix, run the same verifier on those read-back bytes, and retain the authenticated transfer/read-back receipt with the maintenance evidence. Upload the verified evidence and receipt last. The Worker deliberately does not perform a per-blob R2 scan; the privileged maintenance procedure owns full remote retention proof.

`CANDIDATE_HOME_CHECKPOINTS` is a private JSON object mapping an exact account ID to its checkpoint ID. The Worker checks account/machine/home/lane/image bindings, structured maintenance evidence, evidence and manifest hashes, and the verified blob-set digest. It makes four bounded R2 reads per verification; full chunk validation happens in the maintenance tool, not once per blob in a Worker request. Evidence/receipt files are limited to 64 KiB and each manifest to 8 MiB; a larger checkpoint is explicitly blocked pending a bounded verification extension. The Worker checks before interrupting a current owner, then rechecks after all owners stop. A changed final manifest, absent/unverified receipt or old controller stops the transition. Keep retained chunks intact and private after verification; the runtime verifies canonical chunk hashes again on restore. Only a trusted maintenance operator can create these R2 receipts; a receipt asserts the provenance of its full-state evidence and is not itself proof that the old runtime saved successfully.

For rollback, quiesce the candidate and create a fresh full-state checkpoint targeting `standard` or `large` with that lane's verified image digest. Change the private checkpoint selection and remove the account from the candidate allowlist with a Worker-only deploy. The original owner starts only after the candidate exits and the new checkpoint passes. Verify sessions and conversation identity afterward. Retained checkpoints contain credentials: keep them private, retain them through acceptance, and remove them through the approved retention process. Removing a home deletes its canonical state and its retained checkpoints and tombstones every owner.

Create a local acceptance JSON file shaped as follows. Copy desktop SHA, version, run and binary hashes from the candidate manifest. Replace each `pending` only after that check passed, and link its actual receipt. Copy the complete frozen `phone` and `cloud` records into the indicated receipts; a generic pass or a receipt from another build does not qualify. The three source SHAs may differ, but every receipt must match its frozen source. Top-level provider versions must match the Cloud image. Acceptance schema version 3 is required.

```json
{
  "schemaVersion": 3,
  "sourceSha": "FULL_CANDIDATE_SHA",
  "version": "X.Y.Z",
  "candidateRunId": "RUN_ID",
  "assets": {
    "later.dog-macOS-arm64.zip": "ZIP_SHA256",
    "later.dog-macOS-arm64.dmg": "DMG_SHA256"
  },
  "phone": {
    "sourceSha": "FULL_PHONE_SHA",
    "appVersion": "PHONE_APP_VERSION",
    "runtimeVersion": "PHONE_RUNTIME_VERSION",
    "buildNumber": "PHONE_BUILD_NUMBER",
    "ascBuildId": "ASC_BUILD_UUID",
    "easBuildId": "EAS_BUILD_UUID"
  },
  "cloud": {
    "sourceSha": "FULL_CLOUD_SHA", "imageDigest": "sha256:IMAGE_SHA256",
    "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" }
  },
  "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" },
  "checks": {
    "fresh-install": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA" },
    "previous-stable-upgrade": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA" },
    "cloud-test-home": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CLOUD_SHA", "environment": "staged", "homeId": "STAGED_HOME_ID",
      "cloud": {
        "sourceSha": "FULL_CLOUD_SHA", "imageDigest": "sha256:IMAGE_SHA256",
        "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" }
      }
    },
    "expo-development": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_PHONE_SHA",
      "appVersion": "PHONE_APP_VERSION", "runtimeVersion": "PHONE_RUNTIME_VERSION"
    },
    "exact-testflight-build": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA",
      "phone": {
        "sourceSha": "FULL_PHONE_SHA", "appVersion": "PHONE_APP_VERSION", "runtimeVersion": "PHONE_RUNTIME_VERSION",
        "buildNumber": "PHONE_BUILD_NUMBER", "ascBuildId": "ASC_BUILD_UUID", "easBuildId": "EAS_BUILD_UUID"
      }
    },
    "real-account-conversation": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "phoneSourceSha": "FULL_PHONE_SHA",
      "cloud": {
        "sourceSha": "FULL_CLOUD_SHA", "imageDigest": "sha256:IMAGE_SHA256",
        "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" }
      }
    },
    "real-iphone": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "deviceType": "physical",
      "phone": {
        "sourceSha": "FULL_PHONE_SHA", "appVersion": "PHONE_APP_VERSION", "runtimeVersion": "PHONE_RUNTIME_VERSION",
        "buildNumber": "PHONE_BUILD_NUMBER", "ascBuildId": "ASC_BUILD_UUID", "easBuildId": "EAS_BUILD_UUID"
      },
      "cloud": {
        "sourceSha": "FULL_CLOUD_SHA", "imageDigest": "sha256:IMAGE_SHA256",
        "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" }
      }
    },
    "workspace-identity": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "phoneSourceSha": "FULL_PHONE_SHA",
      "cloud": {
        "sourceSha": "FULL_CLOUD_SHA", "imageDigest": "sha256:IMAGE_SHA256",
        "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" }
      }
    },
    "desktop-mobile-compatibility": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA",
      "phone": {
        "sourceSha": "FULL_PHONE_SHA", "appVersion": "PHONE_APP_VERSION", "runtimeVersion": "PHONE_RUNTIME_VERSION",
        "buildNumber": "PHONE_BUILD_NUMBER", "ascBuildId": "ASC_BUILD_UUID", "easBuildId": "EAS_BUILD_UUID"
      },
      "cloud": {
        "sourceSha": "FULL_CLOUD_SHA", "imageDigest": "sha256:IMAGE_SHA256",
        "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" }
      }
    },
    "native-claude": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "providerVersion": "EXACT_CLAUDE_VERSION",
      "cloud": {
        "sourceSha": "FULL_CLOUD_SHA", "imageDigest": "sha256:IMAGE_SHA256",
        "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" }
      }
    },
    "native-codex": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "providerVersion": "EXACT_CODEX_VERSION",
      "cloud": {
        "sourceSha": "FULL_CLOUD_SHA", "imageDigest": "sha256:IMAGE_SHA256",
        "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" }
      }
    },
    "independent-review": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "phoneSourceSha": "FULL_PHONE_SHA", "cloudSourceSha": "FULL_CLOUD_SHA" }
  }
}
```

## Promote the accepted bytes

Add `sources` records for `desktop`, `phone` and `cloud`, each with its GitHub `repository` and merged `prNumber`. Promotion fetches each PR and compares its exact head to `main`; an arbitrary workflow ref cannot qualify. Add `reviews` records for those same three sources. Desktop and Cloud records contain `jobId`, `reviewerJobId` and `patchSha256`. Promotion reads both jobs and the retained patch through the authenticated later.dog supervisor, checks the distinct review task, exact source, `pass` verdict and summary, then hashes the actual artifact. A stale review or unavailable service blocks publication.

For a locally authored PR reviewed by a standalone Cloud task, use `{ "kind": "supervisor-standalone", "jobId": "REVIEW_JOB", "patchSha256": "SHA256", "implementationSessionId": "AUTHOR_SESSION" }`. The authenticated job must be ready, have a distinct task ID, permit only `.laterdog-review.json`, and explicitly name the accepted head in its brief. Promotion requires its base and retained input ref to equal the accepted head and verifies that ref through GitHub, then checks the exact head and `pass` verdict in the fetched review-only patch. The input ref must remain available through promotion. A review of an earlier head never qualifies a later repair.

When the independent phone reviewer cannot access the private repository through the Cloud supervisor, its record may instead be `{ "kind": "retained-independent-session", "artifact": { "path": "phone-review.json", "sha256": "SHA256" } }`. That retained JSON must contain `headSha`, `repository`, `verdict`, `summary`, nonempty `checked`, `limitations`, `reviewer: { "kind": "isolated-agent", "sessionId": "REVIEW_SESSION" }` and a distinct `implementationSessionId`. This is retained operator evidence of the separate review, not a supervisor-verified verdict. Desktop and Cloud have no such substitution.

Every non-review check also needs `receipt: { "path": "receipts/CHECK.json", "sha256": "SHA256" }`. Paths are relative to the acceptance file's private directory. Each retained receipt contains `schemaVersion: 1`, `check`, `status: "pass"`, that check's `sourceSha`, `candidateRunId`, `desktopZipSha256`, `phoneSourceSha`, `ascBuildId`, `cloudImageDigest`, concrete `observations: ["..."]`, and at least one `artifacts: [{ "path": "evidence/ACTUAL_FILE", "sha256": "SHA256" }]`. Promotion reads and hashes these files, rejects paths outside the directory and changed artifacts, and checks their build identities. Physical device, account, runtime instance identity and behavior observations remain operator-derived evidence; hashes preserve what was observed but do not create a pass or replace actually doing those checks.

Add `cloud.buildRunId` and `cloud.receiptSha256` from the successful frozen `cloud-home-image.yml` run's `later.dog-cloud-image-receipt` artifact. That workflow records the pushed OCI digest and executes both installed provider binaries with `--version` inside the image. Promotion downloads the artifact itself, verifies its run/source/digest/hash, and compares observed versions with exact source Dockerfile pins. Rehosting the image still requires verifying the actual Cloudflare instance digest and provider versions during the retained account/device checks.

Promotion queries the exact App Store Connect build, its app, prerelease version and beta detail, and the exact EAS build. They must agree on app identity, version, build number, source, runtime, store distribution and beta channel; ASC must report a valid, unexpired build in internal or external beta testing for acceptance. External group approval and distribution remain the separate follow-on gate. An authenticated EAS GraphQL read must report `isGitWorkingTreeDirty: false`; unknown and dirty are rejected. `build:inspect --stage archive` can retain the local would-upload source for operator inspection, but that directory is not proof of an earlier uploaded archive. Keep the real clean-source/build logs in the exact-TestFlight receipt. Use EAS CLI 24+ and a clean phone checkout at the frozen SHA; `LATERDOG_EAS_CLI` may select the installed pinned CLI executable. CLI/API schema or authentication failures block promotion rather than falling back to acceptance strings.

From the candidate source commit with Node 24 and installed pnpm dependencies, first check:

```sh
node scripts/promote-laterdog-candidate.mjs --run-id RUN_ID --evidence /path/to/acceptance.json --phone-directory /path/to/frozen-phone
```

The check downloads the workflow artifact itself, matches all hashes and acceptance receipts, confirms the pinned successful packaging run, and waits for every required job in the source commit's CI run. Pull-request merge-ref CI, skipped/missing jobs, stale review and a newer existing stable version do not qualify. It never creates CI branches or starts workflows.

Once the authorized acceptance gates pass, publish:

```sh
node scripts/promote-laterdog-candidate.mjs --run-id RUN_ID --evidence /path/to/acceptance.json --phone-directory /path/to/frozen-phone --publish
```

Promotion creates a draft at the pinned SHA, uploads the four public assets, downloads them again to verify exact hashes, then marks the release public and Latest. A retry reuses a matching draft or verifies an already published release; it never replaces published binaries. The acceptance file stays local. A conflicting tag, changed asset, failed CI or incomplete receipt stops promotion while the existing stable distribution remains available.

Check the public DMG download and updater manifest after promotion. Distribute the matching TestFlight build through the phone repository's process only after its physical-device and account acceptance also passed. Coordinate the accepted Cloud image rollout separately and verify the deployed digest and provider versions; desktop promotion does not deploy Cloud home. Update the finish-line tracker with all source SHAs, artifact hashes, Cloud digest, provider versions, phone build and evidence.

## Signing and recovery

The Developer ID setup helper remains `pnpm laterdog:apple-signing <AuthKey.p8> <Issuer ID>`. It validates the key, exports the signing identity and stores the repository secrets without printing them. The recorded certificate, Developer ID Application: The Interpreting App, LLC (5JAPUBC2B6), expires February 1, 2027; confirm the actual identity and renew before expiration.

Modern Developer ID releases update compatible signed installations. Versions before 0.3.11 need a one-time manual reinstall when crossing from the older self-signed identity. Version 0.3.2 and earlier have no updater. Preserve dogs, conversations and settings during either path.

Before promotion, reject the candidate and leave stable untouched. After promotion, withdrawing Latest cannot recall an update already downloaded. Installed apps never downgrade: publish a higher-version repair containing the known-good behavior, verify its data compatibility and upgrade path, and keep the previous release available. Never mark a release Latest without its complete update manifest.
