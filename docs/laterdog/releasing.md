# Push an update

later.dog 0.3.3 and newer update themselves from the newest GitHub release of `woodbeary/later-dog`. Publishing a release is how an update reaches people. Within an hour, or at their next launch, the app downloads it and a small icon appears at the bottom of the sidebar. Clicking it shows what's new and **Restart to update**.

## Steps

1. Set the new `version` in `package.json`, for example `0.3.4`.
2. Add `## 0.3.4 — 2026-10-11` to the top of `CHANGELOG.md`. Its text becomes the release notes and the app's "What's new". A heading that still says "unreleased" is refused.
3. Push to `main`.
4. On Jacob's Mac, from a clean worktree of that commit, run the release:

   ```sh
   scripts/laterdog-release-mac.sh v0.3.4
   ```

   It packages the app, runs the packaged-server smoke test, checks the signature and update feed, notarizes and staples the app and the disk image, then publishes the release. later.dog has no GitHub Actions workflows: builds, tests and releases run from Jacob's Mac. `LATERDOG_RELEASE_DRY_RUN=1` stops before publishing.
5. Check that the release has four files: `later.dog-macOS-arm64.dmg`, `later.dog-macOS-arm64.zip`, `SHA256SUMS.txt` and `latest-mac.yml`. New installs use the disk image, which the Download button on later.dog serves; installed apps update from the zip.

## What the script refuses

- A checkout with uncommitted changes, or a commit that isn't on `origin/main`.
- A tag that doesn't match `package.json`'s version. Installed apps would be offered the same build forever.
- Replacing a release that already exists.
- A Mac without a Developer ID Application identity in its keychain. macOS installs an update only when it is signed like the running app.
- An app without its dictation helper. Packaging carries on when the helper cannot be compiled, so that a Mac without a working Swift compiler can still build; a release must not, or dictation does nothing in it. 0.3.47 went out that way.
- A release whose notarization Apple didn't accept, for the app or for the disk image. The script prints Apple's log and publishes nothing.

## Signing and notarization

Releases are signed with the Developer ID certificate in the Mac's login keychain, notarized by Apple and stapled, for the app and the disk image. People open later.dog with no Open Anyway step.

Notarization uses the App Store Connect API key in `~/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8`. The script takes the key ID from that file name (or `APPLE_API_KEY_ID`) and the issuer from `APPLE_API_ISSUER`, or from the signed-in `asc` CLI (`asc auth issuer-id`). It prints neither.

The certificate in use, "Developer ID Application: The Interpreting App, LLC (5JAPUBC2B6)", expires on February 1, 2027. Renew it before then.

## Previews

A tag such as `v0.3.4-preview.1` publishes a prerelease without `latest-mac.yml`. Installed apps aren't offered it; testers download it by hand.

## What people see

- The icon shows a ring while the update downloads, then an arrow when it's ready.
- **Restart to update** installs it now. Otherwise it installs the next time later.dog quits. Nothing restarts by itself while a dog works.
- **Check for updates** is in Settings, Updates.
- 0.3.2 and earlier have no updater. People on them download the new version once.

## Careful

- Installed apps read the release GitHub marks **Latest**. A release made by hand without `latest-mac.yml` hides updates from everyone until the next proper one.
- Deleting a release doesn't take an update back from apps that already downloaded it, and apps never move to an older version. To undo a bad version, publish a newer one.

## Tested

On 2026-10-10 a signed 0.3.3 updated itself to a throwaway signed 0.3.4 served from this Mac. The download, the icon, the notes, **Restart to update** and the new version's signature were all checked. A real GitHub release hasn't been through it yet.
