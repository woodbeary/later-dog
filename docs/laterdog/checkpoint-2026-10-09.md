# Checkpoint 2026-10-09: the simple later.dog

The newest version that builds and passes its local checks. Saved so Jacob can review before more work piles up.

## Where it is

- **Branch:** `biscuit/simplify-wording`, in the worktree `~/code/dog-biscuit-settings`. It sits on PR #1 (`biscuit/launch-no-prompts`, launch without permission prompts).
- **Tag:** `checkpoint-2026-10-09`
- **Version:** 0.3.0, then 0.3.1 and 0.3.2 with the live chat fixes (TODO 1), then 0.3.3 (unreleased) with the update icon, pictures while a dog works, the × on a question, and the 4-picture limit. Not merged and not released.
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
     - `cloud-pro.md` (it still describes lending), `copy-workspace.md`, `ios-companion.md` (these two also still send people to Connect your phone)
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
11. **A close button on a dog's question:** done for 0.3.3; checked with tests, not yet in the installed app. Asked for by Jacob on 2026-10-09.
    - **What it does:** every open question card, a new dog's first one included, has an × in its corner. Closing it tells the dog the question was closed, so the dog stops waiting, hides the card, and puts the cursor in the message box. A question still showing after its turn ended, or after a restart, closes without starting a new turn.
    - **Code:** `server/laterdog/close-question.ts`, used by both respond routes in `server/index.ts`, and `src/components/QuestionCard.tsx`.
    - **Tests:** `server/laterdog/close-question.test.ts`, `server/laterdog/close-question.e2e.test.ts` (a real server and the fake Claude CLI; it fails on the old code), `src/components/QuestionCard.dom.test.ts`.
12. **Adding a picture while a dog works:** fixed for 0.3.3; checked in the browser fixture, not yet in the installed app.
    - **Symptom:** a picture added while a dog worked couldn't steer, and its queue row showed a file path.
    - **Cause:** the server queued every message with a picture on purpose, because a steer could only carry words. Steer on a queued picture was refused the same way.
    - **Fix:** Claude and ChatGPT (Codex) take pictures mid-turn (`server/laterdog/steer-images.ts`, `steerImages` in each driver's capabilities). Sending, Steer on a queued row, and a room's Steer all pass the picture along. Engines that still can't take one mid-turn (OpenAI-compatible, Pi) keep the queue, and the composer offers Stop and send instead of a steer that can't work. A queued picture shows as a thumbnail.
    - **Tests:** `server/laterdog/steer-images.test.ts`, `server/laterdog/steer-images.e2e.test.ts` (a real server and the fake Claude CLI; it fails on 0.3.2), two updated cases in `server/steer-e2e.test.ts`, `server/admission-golden.test.ts`, `src/components/ComposerQueuedMessages.test.ts`.
    - **Not verified:** a real Claude or Codex taking a picture mid-turn. Each gets the same picture input it already takes when a turn starts (Claude image blocks, Codex `localImage`).
13. **Jacob's UI list from 2026-10-09:**
    - **The composer should look like Grok Bot's:** done for 0.3.3; checked in the browser fixture, not yet in the installed app.
      - It is one 44px line when empty: attach on the left, the words, then permissions and send on the right. Two lines of words, a picture or file, the 4-picture note, or a reply make it grow: the words get the full width and the buttons go underneath. It stays big while there are words and shrinks back once they're gone.
      - Pictures are 56px chips in a row inside the box; the reply quote and the 4-picture note are inside it too.
      - Found in the fixture and fixed: the 4-picture note stayed up after sending.
      - Code: `src/components/Composer.tsx`, `src/components/ComposerAttachments.tsx`, `src/lib/composer-expand.ts`. Tests: `src/components/Composer.layout.test.ts`, plus a new case in `src/components/Composer.pictureLimit.test.ts` (it fails on the old code).
    - **Sent pictures:** done for 0.3.3; checked in the browser fixture, not yet in the installed app.
      - **Jacob's report:** a message with pictures and words made a very wide bubble, and a picture on its own wasn't on the right.
      - **Cause:** your pictures were drawn inside the text bubble, in a gallery fixed at 34rem wide. A single picture sat at the left of that box.
      - **Fix, following Grok Bot:** your pictures are their own row on the right, above the words, side by side at one height (192px at most, 6px apart, up to 4 to a row). Each picture is as wide as its shape needs, and the row shrinks to fit a narrow window. The words keep a bubble that fits them; pictures alone have no bubble; a picture-only reply stays in the bubble with its quote. Rooms do the same. A dog's own pictures keep their grid.
      - **Measured in the fixture (1280×720):** four square pictures with "hi there" made a row 672px wide (164px tiles) ending at the right edge, with an 84px "hi there" bubble under it. One portrait picture is 144×192 at the right edge. In a 420px-wide chat the row shrank to 328px.
      - Code: `src/components/AttachmentGallery.tsx` (`sent`), `src/components/ChatView.tsx`, `src/components/GroupView.tsx`, and `onRatio` in `src/components/AttachmentPreview.tsx`. Tests: `src/components/ChatView.pictures.test.ts`, and a new block in `src/components/AttachmentGallery.test.ts`.
    - **Stop a fifth picture when it's picked:** done for 0.3.3; checked with tests, not yet in the installed app. Picking, pasting or dropping counts the pictures already in the message, adds up to 4, and says "A message can have up to 4 pictures." Documents aren't limited. The number lives in `shared/picture-limit.ts`, and the server's own check in `server/turn-images.ts` uses it too. Tests: `src/lib/picture-limit.test.ts` and `src/components/Composer.pictureLimit.test.ts`, which picks, pastes and drops pictures into the composer (3 of its 4 tests fail on the old code).
    - **One "Computer" place, like Grok Bot's:** done for 0.3.3; checked in the browser fixture, not yet in the installed app.
      - **Jacob's report:** "no need for "browser" "files" just "Computer"". The panel's "allow control of this computer", "open the browser tab" and "where it works" made no sense.
      - **What changed:** the panel is one view: a **Computer** title, a green dot while the dog works there, and a close button. It shows the one place the dog's conversation works: the browser for a dog set to Browser, or the screen of its cloud computer, Local VM or This Mac. Each message uses one place (`resolveSurface` in `server/surface.ts`), so there's nothing to switch between. The Browser and Files tabs, the six-card "Where … works" grid with its line, and the pinned-chat note are gone from the panel. "Allow control of this computer" shows only for a dog that works on This Mac and is missing a macOS permission.
      - **Where a dog works** moved to the dog's settings → Computer: one list of the same places, with the same one-line explanation and action (`src/components/WorksOnPicker.tsx`), and **Open Computer panel** under it. Choosing This Mac for an Off-leash dog still asks first.
      - **Browser fixes found on the way:**
        - The panel's download card pointed to the removed tab. It now says "The built-in browser needs a one-time download of about 160 MB." with **Install the browser engine**.
        - The list showed Browser as "Browser is off" and greyed it out while only that one-time download was missing, so no dog could reach the download. A browser that can still be downloaded now counts as ready, and an Admin can choose Browser while it's switched off: its line then offers **Turn on the browser**.
        - A User sees "Ask an Admin to change it." in the panel instead of a button the server would refuse.
        - Settings' browser switch no longer mentions a per-dog switch.
      - **The dog's instructions:** a browser-only turn tells the dog the browser is "in the built-in browser, in the Computer panel" instead of "the Browser tab of the Computer panel" (`server/surface.ts`).
      - **Checked in the fixture:**
        - Browser: the list says "Works in the built-in browser only: web pages, no desktop apps.", and the panel shows the download card.
        - Off: "Pepper has no screen. It can still chat and do anything that doesn't need one." and **Choose where Pepper works**, which opens the dog's settings on Computer.
        - Back on Auto: the download card again.
        - The dog's settings tabs are Details, Library and Computer.
      - **Limits:**
        - The built-in browser can't be opened by hand for a dog that works somewhere else; choose Browser for it instead.
        - The pinned-chat note is gone. A message that fails on the pinned place still offers to switch back.
        - The Files tab's list of changed files is gone. Each finished message's summary still counts them, and the working folder is in the dog's settings.
        - When a ready cloud computer's dog has tools that leave out the computer, the panel doesn't offer "Let … use the computer". The list in the dog's settings does.
        - A dog on This Mac whose model can't control it still gets the technical message. A plain "can't use This Mac" state is a follow-up.
        - The live dot waits until an Auto dog's place is known.
        - The list says the browser is "switched off" even on a server with no browser engine at all. That choice stays greyed out there.
        - The download card's title and button are still English only (upstream text).
        - The app no longer mentions the `laterdog browser install` command.
      - **Code:**
        - `src/components/ComputerPanel.tsx`, `src/components/WorksOnPicker.tsx`, `src/lib/turn-on-browser.ts`
        - `src/components/BotSettingsDialog.tsx`, `src/components/BrowserPanel.tsx`
        - `placeFacts` in `src/lib/place-view.ts`, and `server/surface.ts`
        - removed `src/components/ComputerFilesPane.tsx` and `src/lib/computer-panel-view.ts`
      - **Tests:**
        - `src/components/ComputerPanel.simple.test.ts`, `src/components/ComputerPanel.browser.test.ts`
        - `src/components/WorksOnPicker.test.ts`, `src/components/BotSettingsDialog.simple.test.ts`
        - `server/surface.test.ts`
        - `scripts/testing/cloud-preview.e2e.test.ts`, which drives the real app in a headless browser. It passes on this Mac; CI skips it.
    - **A short account popover** (the "Anthony" menu), plus dragging to reorder accounts: done for 0.3.3; checked in the browser fixture, not yet in the installed app.
      - **Jacob's report:** the menu on the "Anthony" chip looked "long, huge and overwhelming". His screenshot showed it about 1,000px tall: the dog's-model row, six accounts with usage bars, the carry-on switch, the providers with five models and Show all, the effort steps, and Manage AI accounts.
      - **Fix, following Grok Bot's short account menu:** the menu has two pages.
        - **Accounts** lists each signed-in account on one 32px line (usage ring, name, "62% used", a check on the one in use), then the carry-on switch, one **Model** line ("Opus 5.5 · Deep") and Manage AI accounts.
        - Tapping the Model line opens **Models**: the dog's-model row, providers, models and effort, with **‹ Accounts** at the top.
        - With one account shown, the menu opens on Models, and the chip's ring carries its usage. An account that isn't signed in is hidden unless it's the one in use.
      - **Reorder:** drag an account (a grip shows on hover), or press Alt+↑ / Alt+↓ on a focused one. It moves within its own engine only and saves `accountBattery.order`, the order the token battery uses. The drag carries its own type (`application/x-laterdog-account`), and the message box's drop-to-attach only reacts to files, so nothing lands in the message box.
      - **Measured in the fixture (1280×720), three Claude accounts:**
        - The Accounts page is 220px tall and the Models page 383px.
        - Dragging "Personal" above the first account moved it under the pointer and saved the new order on the server.
        - Alt+↓ moved it back down one and saved again.
        - The message box stayed empty. Focus lands on **‹ Accounts** on the Models page, and back on the Model line after going back.
      - **Limits:** dragging needs a mouse or trackpad. On a touch screen it's untested and the grip stays hidden, and Settings → Accounts can't reorder. The "Drag to reorder" hint is English only, like the other account strings.
      - Code: `src/components/AccountSwitcher.tsx`, `src/components/ModelPicker.tsx`, and `useCarryOn` and `shownOrder` in `src/components/AccountsPanel.tsx`. Tests: `src/components/AccountSwitcher.test.ts`, `src/components/AccountsPanel.test.ts`, and the two-page cases in `src/components/ModelPicker.simple.test.ts`.
    - **Remove the Phone features:** done for 0.3.3; checked in the browser fixture, not yet in the installed app.
      - **What went:** the menu under your name lost **Connect your phone** (a line each for this computer and My Cloud) and **Use on your phone**. Move to My Cloud's done note lost its phone line. The menu is now Settings, Keyboard shortcuts, the update line, About, Help Center and Send Feedback.
      - **What stays, hidden:** the pairing code. A link asking for phone pairing (`?desktop-settings=phone`, which 0.3.2 sends when it opens My Cloud for a phone) still opens the pairing dialog, so an older app doesn't land on a dead end. The welcome tour's phone step was already unused.
      - **Limit:** the app no longer lists paired devices. `laterdog sessions` lists them and `laterdog sessions revoke ID` signs one out.
      - **Measured in the fixture (1280×720):** five lines, 212px tall. The fixture has no updater, so the update line doesn't show there.
      - Code: `src/components/SidebarProfileMenu.tsx`, `moveNextSteps` in `src/components/CloudMove.tsx`; `src/components/PhoneAppDialog.tsx` removed. Tests: `src/components/SidebarProfileMenu.test.ts`, `src/components/PhonePairingDialog.test.ts`, `src/components/CloudMove.test.ts`.
    - **"Jump to latest" stays under dialogs, and About's links row isn't cut off:** done for 0.3.3; checked in the browser fixture, not yet in the installed app.
      - **Cause:** one bug. About opens from the menu under your name, inside the sidebar's bar, which is a layer of its own (`isolation: isolate`, z-index 10). Nothing inside that bar can rise above it, so **Jump to latest**, at the same level and later in the page, showed on top of About and covered its Support link. The Full access and computer warnings and the allowed commands list had the same problem inside the message box's layer (z-index 2).
      - **Fix:** the four open at the page root (`createPortal` to `document.body`), as ConfirmDialog already did. The room members panel looked similar but was never covered: nothing caps its z-index of 40, so it stays as it was.
      - **Measured in the fixture (1280×720):** with About open, a click where **Jump to latest** sits lands on About's backdrop, and all six About buttons, Support included, can be clicked. The links row wraps in a narrow window instead of overflowing.
      - Test: `src/components/dialogs.layer.test.ts` (all four fail on the old code).
    - **Profiles:** named setups such as "personal", "business" and "business 2" that switch back and forth without interrupting a dog that is working.
14. **Study Grok Bot's domain transfer flow**, which asks for a Cloudflare sign-in:
    - how it's presented, when it calls its tools, and how it updates as it goes
    - then finish a real transfer with Jacob so later.dog's version has good data behind it
15. **Updates from a small icon:** done for 0.3.3. How to publish one: [releasing.md](releasing.md).
    - **What it does:** a new version downloads in the background. An icon at the top of the sidebar shows a ring while it downloads and an arrow when it's ready. Clicking it shows what's new, **Restart to update** and **Later**.
    - **Bug found and fixed (3dae86d43):** the mac app shipped no `app-update.yml`. The bundled electron-updater reads it before every download, even with the feed set in code, so every download stopped with a missing-file error. The file now ships in `Contents/Resources`, CI checks the built app for it (`macos.yml`), and `electron/update-config.node-test.mjs` runs the updater's own loading code against it.
    - **Verified on 2026-10-10 with real signed builds.** CI built 0.3.3 (3dae86d43) and a throwaway 0.3.4 (branch `biscuit/update-e2e-b`). The 0.3.3 copy ran from a test folder, with its own home folder, against a feed served on this Mac:
      - it found 0.3.4 at its first check, 15 seconds after launch, downloaded it and handed it to macOS's installer (ShipIt)
      - the icon read "later.dog 0.3.4 is ready", and its popover showed the 0.3.4 notes
      - **Restart to update** quit the app, and ShipIt swapped the app in 12 seconds
      - the result was 0.3.4, passed `codesign --verify --deep --strict`, and kept the same designated requirement
      - started again, it found nothing newer and showed no icon
    - **Not verified:**
      - The window after the restart. ShipIt starts the new app through launchd, so in the test it started under the real account, found Jacob's later.dog already running, and exited at the single-instance lock. With one copy installed, the restarted app is the only one.
      - An app in `/Applications`. macOS App Management may treat it differently from one in a test folder.
      - A real GitHub release as the feed.

## Decisions waiting on Jacob

**Features that work but have no switch any more.** The recommendation is to keep them hidden: for a normie app, switching accounts is the fallback that matters. The features:

- automatic fallback to a backup model (off)
- adding an API-key engine such as Mistral or OpenRouter from scratch
- the master remote-access switch
- the per-dog browser and apps switches
- later.dog Cloud sign-in
- the Pack map's sidebar row
- phone pairing: Connect your phone, Use on your phone, and the list of paired devices. Without that list, signing out a lost phone takes `laterdog sessions revoke ID`; a short list in Settings could come back on its own.

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
