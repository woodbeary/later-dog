# Push an update

later.dog 0.3.3 and newer update themselves from the newest GitHub release of `woodbeary/later-dog`. Publishing a release is how an update reaches people. Within an hour, or at their next launch, the app downloads it and a small icon appears at the top of the sidebar. Clicking it shows what's new and **Restart to update**.

## Steps

1. Set the new `version` in `package.json`, for example `0.3.4`.
2. Add `## 0.3.4 — 2026-10-11` to the top of `CHANGELOG.md`. Its text becomes the release notes and the app's "What's new". A heading that still says "unreleased" is refused.
3. Merge to `main`.
4. Run the build with a release tag:

   ```sh
   gh workflow run macos.yml --repo woodbeary/later-dog --ref main -f release_tag=v0.3.4
   ```

   Or in GitHub: Actions → macOS preview build → Run workflow → `main` → release tag `v0.3.4`.
5. Check that the release has three files: `later.dog-macOS-arm64.zip`, `SHA256SUMS.txt` and `latest-mac.yml`.

## What the workflow refuses

- A tag that doesn't match `package.json`'s version. Installed apps would be offered the same build forever.
- Replacing a release that already exists.
- A feed without the "later.dog Developer" signature. macOS installs an update only when it is signed like the running app.

## Previews

A tag such as `v0.3.4-preview.1` publishes a prerelease without `latest-mac.yml`. Installed apps aren't offered it; testers download it by hand.

## What people see

- The icon shows a ring while the update downloads, then an arrow when it's ready.
- **Restart to update** installs it now. Otherwise it installs the next time later.dog quits. Nothing restarts by itself while a dog works.
- **Check for updates** is in the menu under your name and in Settings, Updates.
- 0.3.2 and earlier have no updater. People on them download the new version once.

## Careful

- Installed apps read the release GitHub marks **Latest**. A release made by hand without `latest-mac.yml` hides updates from everyone until the next proper one.
- Deleting a release doesn't take an update back from apps that already downloaded it, and apps never move to an older version. To undo a bad version, publish a newer one.

## Tested

On 2026-10-10 a signed 0.3.3 updated itself to a throwaway signed 0.3.4 served from this Mac. The download, the icon, the notes, **Restart to update** and the new version's signature were all checked. A real GitHub release hasn't been through it yet. Details are in [checkpoint-2026-10-09.md](checkpoint-2026-10-09.md), TODO 15.
