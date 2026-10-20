# Cloud home state and restore points

A Cloud home keeps nothing on its container's disk between wakes. `deploy/laterdog/home/runtime/run.mjs` restores the
home from R2 when the container starts, saves it every minute while it runs, and saves once more when it stops.

## What is saved

Everything lives in the `laterdog-homes` bucket (`laterdog-homes-test` for the test home) under the home's own prefix,
`homes/<container id>/`:

| Key | What it holds |
| --- | --- |
| `manifest.json` | The latest save: every folder, link and file in `/data`, each file as a list of 8 MB pieces |
| `blobs/<sha256>` | One piece, named by its hash, shared by every save that has the same bytes |
| `restore-points/<createdAt>.json` | An earlier `manifest.json`, kept when a different build of the app took over the home |

Every save records the build that wrote it as `app`, for example `0.3.43+5e1f00c0ffee`: the version in the repository's
`package.json` (copied to `/app/cloud/package.json`) and the first 12 characters of the commit the image was built
from (`/app/cloud/build`, written by the `LATERDOG_BUILD` build argument the image workflows pass).

## Restore points

When a container wakes on a home whose `manifest.json` was written by a different build, or by a runtime from before
restore points, the runtime keeps that manifest as `restore-points/<its createdAt>.json` before its first save. The copy
also records `replacedBy` (the new build) and `keptAt`. A hotfix image of the same version counts as a different build,
so every image change gets a restore point, including the upgrade migrations it runs.

- The newest three restore points are kept (`LATERDOG_RESTORE_POINTS` changes the number). Older ones are deleted.
- Cleanup (every 30 saves) keeps every piece the latest save, any restore point, or a restore point still waiting to be
  written refers to. If the restore points cannot be listed or read, cleanup removes nothing that round.
- A failed write is tried again before each save, and saving never waits on it. A state store that refuses restore points
  (a home whose Durable Object still runs Worker code from before them) is noted once in the log and not asked again.

The log says what happened: `0.3.43+5e1f00c0ffee replaces 0.3.42+81e55420b249; keeping a restore point before the first
save`, then `kept restore point 1760900000000.json`.

## Rolling a home back

All Wrangler commands here take `--remote`.

1. Let the home sleep, or stop it, so it cannot save over what you put back.
2. Keep the current save in case you want it back: `wrangler r2 object get
   laterdog-homes/homes/<container id>/manifest.json --file current.json`, then put that file back as
   `restore-points/<its createdAt>.json`. Without that copy, cleanup later removes the pieces only it used.
3. Pick a restore point under `homes/<container id>/restore-points/`. Its `app` names the build that wrote it.
4. Copy it over the manifest: `wrangler r2 object get laterdog-homes/homes/<container id>/restore-points/<name> --file
   point.json`, then `wrangler r2 object put laterdog-homes/homes/<container id>/manifest.json --file point.json`.
5. If the newer build itself caused the damage, deploy the build named by `app` first. Otherwise the next wake runs the
   newer build's migrations again.

The next wake restores the home from that manifest. Every piece it needs is still in `blobs/`.

## Checked, and not yet

Checked on 2026-10-20 outside an image: `run.mjs` itself, with a stand-in launcher, `/app/cloud` holding each build's
version and commit, and the home Worker's own state handler serving a store in memory. Seven wakes, each from an
empty disk: a new home; an upgrade whose launcher rewrote `bots.json` (kept a restore point first); the same build again
(none); a rollback by copying that restore point over the manifest (the next wake restored the earlier `bots.json`);
then three more builds, after which exactly the newest three restore points were left and the store held exactly the
pieces the manifest and those three refer to.

Not checked yet: the image build with `LATERDOG_BUILD`, R2 itself, and a home on Cloudflare. A home whose Durable
Object still runs Worker code from before restore points refuses them (400), so the first deploy keeps none for homes
that were running during the rollout; the next upgrade after that does.

