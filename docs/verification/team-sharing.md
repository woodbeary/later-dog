# Sharing one dog

What it covers: the **Share** button in a dog's panel (**Create a copy** and
**Save as a file…**), the file it saves (package format v2, one dog), and the
**Add this dog?** sheet that opens when someone drops a `*.laterdog.json` file
on the sidebar or opens a later.dog package link. There is no templates
gallery, pack sharing or import tab any more. The product behaviour is
described in [../team-sharing.md](../team-sharing.md).

## HTTP round trip

```sh
pnpm exec vitest run server/team-share.e2e.test.ts --silent=false
```

This launches and cleans its own fake-engine fixture through
`launchVerificationServer` (no live URL, no user data).

- **One dog.** `POST /api/teams/export` with `{ botId }` builds a file with
  only that dog (named after it), its routine paused on import, and nothing
  from its section or the other dog in it. An unknown or hidden dog is a 404
  ("That dog no longer exists."). Importing the file creates `Scout 2` outside
  any section and adds no section named after the dog
  (`server/laterdog/dog-share.ts`).
- **Whole-section export** (`{ team }`, kept on the server for older clients and
  the organization channel): redaction, skipped command servers, stable keys
  across renames, `?trust=org` refused for files, library-only and version 3
  files, plus the skill-limit refusals that keep `choices.skills` and the
  address redaction.

The printed JSON line names each fixture's data directory and server log.

## Format, export and import units

```sh
pnpm exec vitest run shared/package-format.test.ts server/package-export.test.ts server/package-import.test.ts server/bot-package.test.ts
```

These are unchanged by the move to one-dog sharing: format parsing and
fixtures, export redaction and caps, address rules, and the importer's
rollback, policy refusals and organization path.

## Renderer

```sh
pnpm exec vitest run src/lib/dog-share.test.ts src/components/AddDogSheet.test.ts src/lib/team-import.test.ts
```

`src/lib/dog-share.test.ts` covers the one-dog request body, the starter-notes
line, picture preparation and the words for skipped parts.
`src/components/AddDogSheet.test.ts` covers the sheet's title, reading a dropped
file (Markdown as text, unreadable JSON and files over 50 MB refused in plain
words), which dropped files the sidebar takes (only `*.laterdog.json` and
`*.dogteam.json`; anything else stays a composer attachment), and the toast.

In an isolated `control-laterdog ui launch` app: open a dog's panel, press
**Share**, choose **Save as a file…**, then **Save file**; the dialog says
"Saved NAME-1.0.0.laterdog.json". Dropping that file on the sidebar (a
`DragEvent` with a `DataTransfer` file in `ui eval`) opens **Add this dog?**
listing "NAME 2"; **Add** adds the copy unassigned, and the composer gets no
attachment. **Create a copy** duplicates the dog.

## 2026-10-18: what was actually run

On macOS (arm64), against disposable fixtures only, for the finalize slice
`d3-chief-packs-teams`: `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`,
`server/team-share.e2e.test.ts`, `server/package-export.test.ts`,
`server/package-import.test.ts`, the renderer tests above and the UI recipe.
Evidence: `/Volumes/laterdog-phone/tmp/finalize-2026-10-18/d3-chief-packs-teams/`
(`11-dog-share-menu.png` to `17-create-copy.txt`).

Not verified: a real link from a share host (there is none yet, so
"Share a template link" is not offered), the native save dialog in the packaged
app, and a real Finder drag (the drop was synthesized in the page).
