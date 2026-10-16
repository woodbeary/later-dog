# Push an update

The public macOS update is GitHub's **Latest** release of `woodbeary/later-dog`. Publishing it reaches installed apps: they check at launch and hourly, download the ZIP, and offer **Restart to update**. The DMG is for new installs. The supported public build is macOS Apple silicon.

Build a candidate first. A candidate workflow has read-only repository permissions and cannot publish a release. Promotion uploads the exact accepted bytes; it never rebuilds them.

## Prepare the candidate

1. Set a new stable `version` in `package.json` and add its dated section to `CHANGELOG.md`. An `unreleased` heading is refused.
2. Complete the change's isolated verification and independent review, then merge the authorized release commit to `main`. Record that exact SHA; any source change requires new evidence.
3. Request a candidate:

   ```sh
   gh workflow run macos.yml --repo woodbeary/later-dog --ref main -f release_tag=vX.Y.Z
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

Also verify the authorized real account, its conversations, both native providers, and the physical iPhone against the candidate combination. Freeze the phone source SHA, app version, Expo runtime version, build number, EAS build ID and App Store Connect build ID before acceptance. Record the exact Claude and Codex versions. A fixture or simulator pass cannot qualify real-provider or real-device behavior. Keep account details and credentials out of public release notes.

Keep Expo development verification separate from verification of the exact TestFlight build. Verify the actual account, workspace and conversation identity on both surfaces. The companion compatibility receipt must cover the frozen phone with the candidate desktop and the currently distributed companion versions; do not assume everyone updates together. Independent review must name both frozen source SHAs. A changed phone runtime, build or provider version invalidates the affected acceptance receipts.

Create a local acceptance JSON file shaped as follows. Copy desktop SHA, version, run and binary hashes from the candidate manifest. Replace each `pending` only after that check passed, and link its actual receipt. Copy the complete frozen `phone` record into each build-specific receipt; a generic pass or a receipt from another build does not qualify. Phone and desktop source SHAs may differ, but every receipt must match its frozen source. Acceptance schema version 2 is required.

```json
{
  "schemaVersion": 2,
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
  "providerVersions": { "claude": "EXACT_CLAUDE_VERSION", "codex": "EXACT_CODEX_VERSION" },
  "checks": {
    "fresh-install": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA" },
    "previous-stable-upgrade": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA" },
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
    "real-account-conversation": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "phoneSourceSha": "FULL_PHONE_SHA" },
    "real-iphone": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "deviceType": "physical",
      "phone": {
        "sourceSha": "FULL_PHONE_SHA", "appVersion": "PHONE_APP_VERSION", "runtimeVersion": "PHONE_RUNTIME_VERSION",
        "buildNumber": "PHONE_BUILD_NUMBER", "ascBuildId": "ASC_BUILD_UUID", "easBuildId": "EAS_BUILD_UUID"
      }
    },
    "workspace-identity": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "phoneSourceSha": "FULL_PHONE_SHA" },
    "companion-compatibility": {
      "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA",
      "phone": {
        "sourceSha": "FULL_PHONE_SHA", "appVersion": "PHONE_APP_VERSION", "runtimeVersion": "PHONE_RUNTIME_VERSION",
        "buildNumber": "PHONE_BUILD_NUMBER", "ascBuildId": "ASC_BUILD_UUID", "easBuildId": "EAS_BUILD_UUID"
      }
    },
    "native-claude": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "providerVersion": "EXACT_CLAUDE_VERSION" },
    "native-codex": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "providerVersion": "EXACT_CODEX_VERSION" },
    "independent-review": { "status": "pending", "evidence": "", "sourceSha": "FULL_CANDIDATE_SHA", "phoneSourceSha": "FULL_PHONE_SHA" }
  }
}
```

## Promote the accepted bytes

From the candidate source commit with Node 24 and installed pnpm dependencies, first check:

```sh
node scripts/promote-laterdog-candidate.mjs --run-id RUN_ID --evidence /path/to/acceptance.json
```

The check downloads the workflow artifact itself, matches all hashes and acceptance receipts, confirms the pinned successful packaging run, and waits for every required job in the source commit's CI run. Pull-request merge-ref CI, skipped/missing jobs, stale review and a newer existing stable version do not qualify. It never creates CI branches or starts workflows.

Once the authorized acceptance gates pass, publish:

```sh
node scripts/promote-laterdog-candidate.mjs --run-id RUN_ID --evidence /path/to/acceptance.json --publish
```

Promotion creates a draft at the pinned SHA, uploads the four public assets, downloads them again to verify exact hashes, then marks the release public and Latest. A retry reuses a matching draft or verifies an already published release; it never replaces published binaries. The acceptance file stays local. A conflicting tag, changed asset, failed CI or incomplete receipt stops promotion while the existing stable distribution remains available.

Check the public DMG download and updater manifest after promotion. Distribute the matching TestFlight build through the phone repository's process only after its physical-device and account acceptance also passed. Update the finish-line tracker with source SHA, artifact hashes, provider versions, phone build and evidence.

## Signing and recovery

The Developer ID setup helper remains `pnpm laterdog:apple-signing <AuthKey.p8> <Issuer ID>`. It validates the key, exports the signing identity and stores the repository secrets without printing them. The recorded certificate, Developer ID Application: The Interpreting App, LLC (5JAPUBC2B6), expires February 1, 2027; confirm the actual identity and renew before expiration.

Modern Developer ID releases update compatible signed installations. Versions before 0.3.11 need a one-time manual reinstall when crossing from the older self-signed identity. Version 0.3.2 and earlier have no updater. Preserve dogs, conversations and settings during either path.

Before promotion, reject the candidate and leave stable untouched. After promotion, withdrawing Latest cannot recall an update already downloaded. Installed apps never downgrade: publish a higher-version repair containing the known-good behavior, verify its data compatibility and upgrade path, and keep the previous release available. Never mark a release Latest without its complete update manifest.
