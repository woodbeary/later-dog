# Checkpoint 2026-10-09: the simple later.dog

The newest version that builds and passes its local checks. Saved so Jacob can review before more work piles up.

## Where it is

- **Branch:** `biscuit/simplify-wording`, in the worktree `~/code/dog-biscuit-settings`. It sits on PR #1 (`biscuit/launch-no-prompts`, launch without permission prompts).
- **Tag:** `checkpoint-2026-10-09`
- **Version:** 0.3.0, then 0.3.1 and 0.3.2 with the live chat fixes (TODO 1). Not merged and not released.
- **Draft PR:** stacked on PR #1. The CI build is a workflow artifact, not a public release.
- **Changes:** [CHANGELOG.md](../../CHANGELOG.md)

## Direction

- later.dog should feel like Grok Bot: someone who isn't technical can install it, sign in, make a dog and talk to it without meeting a setting they don't understand.
- **Settings** keeps four pages:
  - General: accounts, Profile, Appearance and System
  - Computer
  - Usage: usage and estimated cost stay visible
  - Updates
- **Accounts** work like Grok Bot's account switcher:
  - add an account and name it
  - see each one's usage
  - switch with one tap
  - when one runs out, keep going on another
- **A dog** has a breed, a colour, a name, what it helps with, and its instructions. Nothing else is required.
- **Hidden features:** anything technical that still works but has no switch stays hidden for now (see Decisions).
- **No code comments.**
  - Done: every comment this branch added is gone.
  - Not done: the upstream comments are still there (see TODO).

## What changed

Compared with `main`, this is 45 commits; about 430 files changed, about 9,000 lines added and 43,000 removed. In order:

1. **PR #1:** launch without permission prompts.
2. **Three branches, merged together in 7668c9f52:**
   - Settings down to four pages
   - the dog editor down to three tabs, plus the new-dog dialog
   - Accounts and Usage: the account list, the in-chat limit message with Continue on, and the held queue
3. **Built on top:**
   - account and model changes while a dog works
   - usage in the model picker
   - walk-away pickup after a reset
   - one face for a working dog
   - Steer now / Queue / Stop and send
   - saved API keys under General
   - About me back under General
4. **This session:**
   - a duplicated dog keeps its breed and colour
   - the Local VM Start button is back
   - the continue-on route moved to its own file
   - the app menu lost Connect to a server and Sign in with your organization
   - the organization restart flag gets cleared
   - dead engine cards removed
   - the last comments this branch added deleted
   - half the docs cleanup

## Verified

Run locally on Node 24 against the tree that became the checkpoint commit (78dbe9245 plus the version bump, changelog, this doc and the workflow step):

- `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`: all pass.
- `pnpm laterdog:test`: 24 files, 183 tests pass.
- `vitest run src shared server/routes`, plus the index-route ratchet and the verification-docs test: 3,474 of 3,476 tests pass.
  - The 2 failures are the verification-docs test (see Known failing).
- `pnpm test:electron`: 662 pass, 0 fail, 3 skipped.
- No comment lines added by this branch.

CI on the draft PR runs the whole vitest suite in four shards plus the broker, electron, supervisor-container and worker jobs. Its result is recorded on the PR.

## Not verified

- **None of this has run in the real app yet.** The installed app is v0.2.0, from before this work. The 0.3.0 build from this checkpoint is the first chance to see it.
- No real Claude or ChatGPT sign-in through the new Add account sheet.
- No real usage limit has triggered the Continue on message or the walk-away pickup. Fixture success does not qualify a live provider.
- Not tried against a real device or service:
  - phone pairing with a real phone
  - pairing with a real later.dog Cloud
  - the Local VM Start button on a real VM
  - Windows and Linux
- No side-by-side comparison with Grok Bot.
- The browser e2e suite (`scripts/testing/*.e2e.test.ts`) has only had a partial local rerun since the cleanup (see Known failing).
  - At its last full run, 17 of 25 files failed; 9 of those fail on `main` too.

## Known failing

Fixed in 0.3.2: `scripts/testing/verification-docs.test.ts` and `scripts/brand-links.test.ts` pass again. The nine docs under `docs/verification/` no longer cite deleted files, and the old upstream name is gone from the changelog and this doc.

Local-only failures, seen on 2026-10-09:

- `server/control-laterdog.test.ts` ("drives a real fake-engine turn") expects only the fake Claude engine. On a Mac with the Codex CLI on its PATH it also finds ChatGPT. It fails the same way on 0.3.1.
- With the pinned test browser installed, the `scripts/testing/*-ui.e2e.test.ts` files run instead of skipping. A partial run failed 9 of them; the usage details one was rerun on 0.3.1 and fails the same way. CI has no such browser and skips them (TODO 4).

## TODO, in order

1. **Live progress in later.dog's chat.**
   - **Messages:** fixed in 0.3.1; not yet checked in the installed app.
     - **Symptom:** interim messages from a working dog only appeared after pressing Stop and sending again.
     - **Cause:** the chat shows the line of messages ending at its newest one. A message sent while a dog worked was shown at once, and the dog's new messages waited behind it. If the send came back queued (a message with a picture always does) or failed, the chat went back to where it was before the send. It never moved on to the dog's newer messages, so it hid every message after that. The server sent all of them on time.
     - **Fix:** the chat moves forward along its own line (`src/lib/leaf-follow.ts`, used in `src/state/store.tsx`). Four new tests in `src/state/store.test.ts`; three of them fail without the fix.
   - **Pictures:** fixed in 0.3.2; not yet checked in the installed app.
     - **Symptom:** screenshots a dog took while it worked showed up only after pressing Stop, and then most of them vanished or piled up at the end of its last reply.
     - **Cause:** the server held every picture until the turn ended, then attached them all to the dog's final reply. Stop deleted the held files.
     - **Fix:** each picture is saved and posted as its own message the moment it arrives, where it was taken (`server/laterdog/turn-images.ts`). The "Worked for…" fold never hides a picture, and a picture landing after the dog's written answer doesn't replace it as the turn's answer.
     - **Tests:** `server/laterdog/turn-images.test.ts`, `server/laterdog/turn-images.e2e.test.ts` (a real server and the fake Claude CLI, including Stop), two in `server/store.test.ts`, one in `src/lib/activity-runs.test.ts`. The end-to-end test fails on 0.3.1: the screenshot never shows while the dog works.
2. **Finish the docs.**
   - The nine verification docs: done in 0.3.2.
   - These guides still send people to Settings pages that are gone:
     - `docs/custom-engines.md`, `self-hosting.md`, `composio.md`, `custom-mcp-servers.md`
     - `organization-branding.md`, `byo-vps.md`, `desktop-companion.md`
     - `cloud-pro.md` (it still describes lending), `copy-workspace.md`, `ios-companion.md`
     - `docs/verification/server-settings.md`, `codex-account.md`, `organization-settings.md`, `engines.md`
3. **Fix words on screen and in errors that point at removed pages.**
   - **Settings → Tricks:** the dog's Library tab (`src/components/bot-settings/SkillsSection.tsx`).
   - **Settings → Remote access:**
     - `server/cli.ts`
     - `server/cloud-owner.ts`
     - `remote.client.hostHint` in `en.json`
   - **Settings → later.dog Cloud:**
     - `server/system-prompt.ts`
     - `server/index.ts`
     - `src/pair/PairPage.tsx`
   - **Settings → Computers / App Settings:** `server/cli.ts` and `server/index.ts`.
   - **Phone control (`server/index.ts`):** the error says to "Select Per dog in Settings → Computers", and that choice no longer exists anywhere. This needs a real fix, not new wording.
   - **The cloud sign-in note** still recommends an API key, but that screen no longer accepts one.
4. **Run the full browser e2e suite** and compare it file by file with `main`.
5. **Remove dead leftovers:**
   - `laterdog-show-run-card` in the backup and preload key lists
   - `BotActivityPicker`
   - `CloudMoveSettings` and `CloudMoveImport`
   - `PhoneBeat`
   - `bot-settings/VoiceSection.tsx` and its only test
   - the `DefaultBotSettings` no-op
   - `NewBotDialog`'s `defaultsMode`
   - the unused server `bot-presets` route
   - `src/lib/interface-mode.ts`
   - `CloudBackendPicker` and `RoutinesSection`
   - unused locale keys
6. **Translations.** 118 new and 35 reworded English strings show in English in the other nine languages. `main` is already about 60% untranslated, so this is low priority.
7. **`macos.yml` release notes** still describe 0.2.0. Rewrite them before any public release.
8. **Two account-switching edge cases** were left on purpose (details in the accounts report):
   - **A second Continue on with the battery off.** The conversation goes back to the first account when the second resets, even if the first is still resting. The limit message then shows again.
   - **The picker hides more than it must.** Its "resting" filter treats the whole account as resting, while the server lets Sonnet run during an Opus-only limit.
9. **Strip the upstream comments**, which Jacob wants gone everywhere.
   - Cost: every later pull from upstream will conflict on those lines.
   - Plan it as one mechanical commit, run right after an upstream merge.
10. **Sign with Jacob's Developer ID and notarize.** Deferred on 2026-10-08. It is the only full fix for the keychain prompt at launch and Gatekeeper's right-click → Open.
11. **A close button on a new dog's first question.** A new dog opens with a big card asking what it guesses you want. It needs an × so you can close it and just type. Asked for by Jacob on 2026-10-09.
12. **Adding a picture while a dog works is broken.** It can't be queued or used to steer. Reported by Jacob on 2026-10-09; not investigated yet.
13. **Jacob's UI list from 2026-10-09:**
    - **The composer should look like Grok Bot's:** no big left indent, and attached pictures sit inside the box instead of floating above it.
    - **Stop a fifth picture when it's picked**, instead of after.
    - **One "Computer" place** instead of Browser and Files, looking like Grok Bot's. Drop the "allow control of this computer" and "where it works" wording.
    - **A short account popover** (the "Anthony" menu), plus dragging to reorder accounts.
    - **Remove the Phone features.**
    - **"Jump to latest" stays under dialogs**, and the About dialog's links row isn't cut off.
    - **Profiles:** named setups such as "personal", "business" and "business 2" that switch back and forth without interrupting a dog that is working.
14. **Study Grok Bot's domain transfer flow**, which asks for a Cloudflare sign-in:
    - how it's presented, when it calls its tools, and how it updates as it goes
    - then finish a real transfer with Jacob so later.dog's version has good data behind it

## Decisions waiting on Jacob

**Features that work but have no switch any more.** The recommendation is to keep them hidden: for a normie app, switching accounts is the fallback that matters. The features:

- automatic fallback to a backup model (off)
- adding an API-key engine such as Mistral or OpenRouter from scratch
- the master remote-access switch
- the per-dog browser and apps switches
- later.dog Cloud sign-in
- the Pack map's sidebar row

## Try it, roll it back

- **Get the build:**
  1. Run the `macOS preview build` workflow on this branch.
  2. Download the `later.dog-macOS-arm64` artifact.
  3. Unzip it and check it with `codesign --verify --deep --strict later.dog.app`.

  It carries the same "later.dog Developer" signature as v0.2.0, so keychain access and the Mac permissions carry over.
- **Install:**
  1. Quit later.dog.
  2. Move `/Applications/later.dog.app` aside as a backup.
  3. Copy a backup of `~/.laterdog`.
  4. Put the new app in Applications.
- **Roll back:**
  1. Quit.
  2. Put the backed-up v0.2.0 app back.
  3. Restore the `~/.laterdog` copy if anything in the data looks wrong.

  The branch adds no data migration step. It hasn't been run against a real data folder yet, so keep the backup until it has.
