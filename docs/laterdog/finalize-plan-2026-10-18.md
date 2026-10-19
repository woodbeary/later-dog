# Finalize plan, 2026-10-18

The work left before later.dog matches the reference experience on desktop, phone and Cloud home. Each line was checked against `origin/main` at 0.3.41 (`364805d2a`) and then re-checked by a separate reviewer. No build, test or device run was part of the mapping: every "Fixture proof" below is a plan until a lane's PR records it.

Item ids (R1-R24, L6-*, L6b-*) refer to the private study's recommendation list and live-check takeaways. The study's notes stay private; this file states each item in later.dog's terms only.

**Product direction used to judge each item**
1. Less is more: no hard-coded setup flows, caps, server-posted cards or extra rules. The model decides when to show a card. The owner's own Mac is always usable by the owner's dogs with no per-use approval.
2. One workspace per account, held in the Cloud home. Desktop and phone are both screens onto it. No pairing, server picker, "This computer / My Cloud" split or move/copy UI.
3. The same experience on desktop and phone, in plain words, monochrome.

Where the analyst and the checker disagreed, the checker's final status, size and impact are used. Surface key: **D** = desktop (Electron + renderer), **P** = phone, **H** = Cloud home and server.

## 1. Status at a glance

| id | status | surfaces | size | impact | gap today |
|---|---|---|---|---|---|
| R1 | partial | H done; D partial; P partial | M | medium | Phone keeps a message that is queued behind a busy dog marked as "sending", and loses it on relaunch. The queued list has no sendId to match against. |
| R2 | partial | H partial; D partial; P ok | S | medium | A retry of a message that already landed can get a spend-cap or task-switch 409, so the user sees "failed" for a message that is in the chat. |
| R5 | partial | D missing order; P drafts not tied to account | M | medium | On the Mac a later message can overtake an earlier one. Phone drafts stay after sign-out. |
| L6-offline | partial | P done; D missing | L | high | On the Mac, a message sent while offline or while the home wakes disappears after about 30 s and comes back as a toast. Quitting loses it. |
| R3 | partial | D main ok; D helpers, P push not tied to the account | M | medium | Signing out mid-connect can bounce back to the old home. The Claude/ChatGPT hand-over keeps retrying after sign-out. |
| R4 | partial | D main ok; D home page, P gaps | M | medium | A failed sign-out on the home page shows nothing. A lost home cookie shows the pair page. Phone sign-out leaves both server sessions valid. |
| L6-switch | missing | none | L | low | Switching between two later.dog accounts means sign out, enter a code, and start from a cold paint. |
| L6-signout | partial | D mostly; P leaves data | M | medium | Phone archives the account's dogs and chats in backed-up Documents on every sign-out. On the Mac, sign-out restarts the Mac's old local dogs. |
| R6 | conflicts | H, D, P | M | medium | Asking by default goes against direction 1. Separately, dogs placed on the Mac still get "Local computer approval" cards, and a lasting "Always allow" choice shows its reach only on hover. |
| R13 | partial | H | M | low | A thrown delivery says "the action was not run" when nobody knows. An expired form does not say some fields were filled. |
| L6-cmd | partial | D, P | M | medium | The command is hidden behind View details. The sidebar says only "Waiting for you…". Phone cannot remember an exact command. |
| L6b-everywhere | conflicts | H, D, P | S | low | Nothing for the owner's Mac by design. Cards already settle on both screens. A second answer returns 200 "unavailable", not 409. |
| L6b-rules | missing | none | L | high | The Auto-review switch does the opposite of its name. "Declined." does not stop the dog from rewording the same action. There are no plain rules. |
| R7 | partial | H, P | L | medium | An unreadable bots.json, groups.json or routines.json is overwritten with a fresh dog. Cloud keeps no older manifest. A damaged phone archive can block sign-in. |
| L6-paint | partial | P done; D missing | L | high | The desktop shows a splash, or the separate "Waking up My Cloud" page, until the home answers with every dog's last 200 messages. |
| L6-cache | partial | P done; D missing | S | medium | The Mac reopens on the newest dog, which may be hidden, instead of the last chat or the main dog. |
| R8 | partial | H, D, P | M | medium | The phone buzzes for a reply you are reading on the Mac. |
| R9 | partial | H, D | M | medium | An open thumbnail keeps a cloud computer awake for up to 8 h. A slow cold start shows "Couldn't wake". |
| L6-faces | partial | D, P | M | medium | The desktop thumbnail never falls back to asleep. The phone freezes with no "Reconnecting…" text. |
| R21b | partial | P done; D viewer | S | low | The desktop viewer goes blank while it reconnects. |
| R10 | partial | H, D; P no groups | L | high | Group chats never reach the phone. Create can make two dogs. The first question can be skipped. |
| R11 | partial | H, D, P | M | medium | Pack order is kept per device. Pinned Chief and main dog differ between Mac and phone. |
| L6b-hide | partial | P UI; D named Archive; H blocks hidden dogs | L | medium | The phone says hidden dogs keep working, but the server cuts them off from peers, rooms, routines and Slack. |
| L6b-exchange | partial | D, H done; P missing | M | medium | The phone shows one line per dog-to-dog message and you cannot open the exchange. |
| R12 | partial | D, H, P | M | medium | Failure meaning is guessed from strings. The phone has no Sign in, Update or Retry on a failed turn. Bare "waking" can show. |
| L6-scoped | partial | D, P | L | medium | Errors share one global red line, and some never clear. If the home cannot be reached, the window switches to the Mac's own dogs. |
| R14 | partial | H not sealed; D ok; P none | L | medium | Saved keys on a Cloud home are not sealed at rest yet, and MCP servers get more of the environment than they need. Lane 9 fixes both. |
| L6b-forms | partial | H, D, P | M | medium | You cannot decline a form or do it on the screen. The copy does not say what the dog can see. |
| R15 | partial | D, H, P | L | medium | A failed install says nothing. No version guard. The restart warning is wrong on Cloud. The running home image cannot be seen. |
| L6-ask | partial | D installs on quit; P ok | M | high | Clicking Later and then Cmd-Q installs the update anyway. |
| R16 | partial | D fixed hosts only; P dog/chat | M | medium | Mac deep links to a dog or chat do nothing. Server-written thread links are dead text on the phone. |
| L6-strict | partial | P, D | M | medium | On the phone, a missing dog does nothing, a malformed link goes to sign-in, and unknown paths show "Unmatched Route". |
| L6b-linklog | partial | D, P | M | low | No log records why a link or an external open failed. |
| R23 | **done** | D | S | low | None. |
| R17 | partial | H, D local, P | M | medium | Banners replay after a reconnect (local mode). Dock and phone badges count different things. Pushes are never withdrawn. |
| L6b-reply | partial | H done; P partial; D missing | L | high | Cloud home Macs show no banners at all. Phone Reply opens the app and can be lost at cold launch. Room pushes open the wrong place. |
| L6-a11y | partial | D done; P missing | S | low | VoiceOver says nothing when a reply arrives. |
| R18 | partial | H, D, P | M | low | Every replay of speech is synthesized again. Call failures leave no step log. |
| L6b-callrecord | missing | none | L | medium | There is no "Voice chat · 1:46" row. Spoken turns look like typed ones. Calls cannot be rated. |
| L6b-memo | partial | H done; D slider; P file chip | M | medium | On the phone a voice note opens as a file. The desktop shows "--:--" before it loads. |
| L6-dictation | partial | P done; D | M | low | Esc keeps the dictated text instead of cancelling. "Transcribing…" is easy to miss. Take-turns calls have no Mute. |
| R19 | partial | D (dead code) | M | low | Nothing ships today. The opt-out fails open, identifyEmail is unused, and three flags have no toggle. |
| R20 | partial | D, P | S | low | The sidebar says "No usage reported yet" for a failed check. The phone has no plan line. A used-up plan shows no reset date. |
| R22 | partial | H, D, P | M | low | No shared request id. Desktop saves and uploads do not ride out a waking home. |
| L6-settings | partial | D, P | L | medium | Five desktop sections, two update switches, Heel/Off-leash pickers and "My Cloud" wording. No billing line on either app. |
| R21a | partial | H, D | M | medium | The Mac claims app control without macOS permissions. Busy is free text. The prompt says Mac use needs a card. |
| R24 | partial | H, P; D missing | L | high | A Cloud home set up only from the Mac runs routines in UTC. The desktop shows no run history. After 20 routines the dog posts Confirm cards. |
| L6b-plugins | partial | D states only; P none | M | medium | You cannot see what a connector gives your dogs. The phone has no connected-apps list. |
| L6b-mail | missing | none | L | medium | A dog cannot receive email. |

## 2. Already done

- **R23**: window bounds. Normal size is saved apart from maximized and clamped to real displays (dog:electron/main.mjs:148-192, electron/window-state.cjs:7-83, electron/window-state.test.mjs, which is vitest, not node:test). Optional extra: add a version field to the saved file.
- Parts that are already done inside partial items (keep them, do not rebuild):
  - Server idempotent sends by sendId (R1).
  - Phone outbox, progress cue and wake loop (L6-offline).
  - Desktop credential generation counter (R3).
  - Desktop transcript announcer (L6-a11y).
  - Phone first paint from saved state (L6-paint).
  - Phone snapshot refill (L6-cache).
  - Cards settle on every screen (L6b-everywhere).
  - Desktop exchange view (L6b-exchange).
  - Phone settings sheet layout (L6-settings).
  - Server voice notes (L6b-memo).

## 3. Conflicts with the product direction

- **R6** (approvals ask by default, team ceiling): conflicts with direction 1.
  - Compatible part: fail-closed reads; one-time grants kept apart from lasting ones; a visible reach line under "Always allow" on D and P; cutting the unreachable MacApprovals card, grant and timer code.
  - The checker also found code that itself breaks direction 1 and should be fixed:
    - ownerAuto skips local-computer scope (dog:server/index.ts:6846).
    - The acknowledgeLocalAuto gate (server/index.ts:3923, 3951, 4015, 18378, 18940).
    - The phone keeps Mac dogs on Heel (phone:src/lib/settings-words.ts:24-31).
- **L6b-everywhere** (ask on every device before using the owner's computer): conflicts with direction 1. Compatible part: cards already settle on both screens. Lock that with a test, and optionally return 409 for a second answer.
- **Parts of other items that conflict:**
  - **R15**: idle auto-restart of desktop or phone conflicts with L6-ask and less-is-more. The idle guard belongs only to Cloud home rollouts.
  - **L6b-forms**: having the server mint a takeover card would be a server-posted card. Use a person-side `/screen` route that resumes the dog, and let the AI decide.
  - **L6-switch**: a saved-account list sits close to "saved connections". It is acceptable only as a plain email list, if the person uses it.
  - **R16**: the `cloud` link host carries the This-computer/My-Cloud split. Leave it to the split-removal work, not link plumbing.
  - **L6-paint / L6-scoped / R7**: Electron falls back to `LOCAL_ID` (dog:electron/main.mjs:1898-1911, electron/cloud-window.mjs:6-8). That conflicts with direction 2.
  - **L6-settings**: the per-dog Heel/Off-leash pickers and the "My Cloud" wording (including deploy/laterdog/home/src/waking.ts:14-18) conflict with directions 1 and 2.
  - **R24**: today's code conflicts with direction 1. `SELF_ROUTINE_CAP` (server/direct-apply.ts:8) and the cross-dog Confirm/Cancel card (server/routine-requests.ts:1168-1183) should go.
  - **R10**: `MAX_WORKSPACE_BOTS=100` and `MAX_CREATED_BOTS_PER_TURN=4` are artificial limits (see Needs the person).
  - **R21a**: the prompt says the owner approves Mac use "on a card" (server/system-prompt.ts:89), which contradicts the code and the direction.
  - **R20**: the green, yellow and orange meters go against the monochrome direction. The red "Not sent" row (R5) does too.

## 4. Finalize lanes

Ordered by user impact per effort. Each lane is split into small PRs. Every PR is a draft, and merging stays with the person until a live acceptance record exists.

### Lane 1 (P0): Messages never vanish
- **Items:** R2, R5, R1, L6-offline. Shared wake handling from R22(2) and R12(4).
- **Change:**
  1. **S, server.** One helper in server/send-idempotency.ts. Both message routes and `acceptDirectSend` (which the wakeup path also uses) answer an exact sendId match right after the auth and ownership checks and before the spend-cap and task-switch refusals. Keep the fingerprint 409. Add `sendId` to `queuedSteerSnapshot` (server/steer-queue.ts:73-75). Optionally stamp a queued row with its queue time.
  2. **S, desktop.** A per-threadId promise tail in the send and sendGroup effects. Persist the "Not sent" rows in origin localStorage and make them monochrome.
  3. **M, phone.** A `queued:true` receipt marks the bubble accepted: the track drops and the bubble stays in the snapshot. Hydrate `botQueuedMessages` and handle the `bot.queued` frame, joining by sendId. drafts.json becomes `{owner, drafts}` and is cleared on clear/switchTo. Remove the "Send after reconnect" divider and the global error on a failed send. Per-thread lanes in the phone outbox are optional.
  4. **L, desktop.** A saved renderer outbox (src/lib/outbox.ts) keyed by sendId in the home origin's localStorage, with a progress track after 2 s. Hold on `TypeError` or a 503 that carries `x-laterdog-home`, honouring retry-after with a cap like the phone's. Resume on SSE reconnect, `online` or focus. Settle on the echo with the same sendId. A 4xx stays final and goes to `recoverFailedComposerSend`. The same wake rule goes into `api()` (port electron/computer-sharing.mjs:195-200 or the phone's waking rule into shared/home-wake.ts), and `plainClientError` never shows a bare code.
- **Files:** server/send-idempotency.ts(+test), server/index.ts, server/steer-queue.ts, src/state/store.tsx, src/lib/send-retry.ts, src/lib/outbox.ts (new), shared/home-wake.ts (new), src/lib/drafts.ts, src/lib/plain-client-error.ts, src/components/Composer.tsx, ChatView/GroupView. Phone: src/state/{store,outbox,reducer,snapshot,drafts,local-cache,connection}.ts(x), src/lib/{client,wire,composer-drafts}.ts, src/app/chat/[botId].tsx.
- **Size:** L in total (S + S + M + L).
- **Depends on:** nothing.
- **Overlap:** #70 and phone #11 touch store.tsx and transcript rendering, so rebase after them. The parked home-trip-e2e lane.
- **Fixture proof:**
  - Run `scripts/control-laterdog.ts launch` with a slow `FAKE_CLAUDE` mode. Resend sendId X after tripping the spend cap (docs/verification/spend-cap.md): expect 202 with the same id, or 409 if the text changed. Repeat on the group route.
  - Put a proxy in front of the fixture that serves the page and SSE but answers 503 `x-laterdog-home: waking` to POST messages. Send, reload the renderer through the proxy, and confirm the held bubble returns. Lift the block and confirm exactly one row with that sendId.
  - Phone: run Expo Go against the fixture. A queued second message shows no track and survives a relaunch.
  - Unit tests for ordering, the queued receipt and the draft owner.
- **Unverified until live:** waking the real Cloud home on the person's Mac and iPhone. Held messages are not visible while the home page itself cannot load, because of the Electron fallback (Lane 7).

### Lane 2 (P0): Owner's dogs need no asks; Auto-review means what it says
- **Items:** R6 (compatible and root-cause parts), L6b-rules steps 1-2, L6-cmd, L6b-everywhere, R13, R21a step 0, R24 step 2, L6-settings server part.
- **Change:**
  1. **S.** One fixed deny message from `answerRequest`: the person denied it, so do not do it another way.
  2. **S.** Fix the prompt at server/system-prompt.ts:89: the owner's Mac needs no approval.
  3. **M.**
     - Drop the `approvalScope !== 'local-computer'` exclusion in ownerAuto for owner turns.
     - Remove the `acknowledgeLocalAuto` gate for the owner's dogs.
     - Phone `dogsToLetGo` and `startsOffLeash` include local dogs; `requiresApproval` counts only ask and edits.
     - Switch meaning: On means the engine's reviewer decides and escalations become cards (skip ownerAuto). Off means run without asks.
     - Remove `SELF_ROUTINE_CAP` and the cross-dog routine Confirm card. Route through the reviewer when Auto-review is on, update `PROPOSAL_RESULT_PROMPT`, and keep the Undo receipts.
  4. **M.**
     - Show the command open in a mono block (capped height) on D ApprovalCard and PendingApprovalPanel and on P ApprovalPanel.
     - Sidebar "Waiting for you: <toolPhrase>".
     - Phone exact-command Always allow (`rememberCommand`).
     - One visible reach line under the lasting button.
  5. **S-M.**
     - Cut MacApprovals down to settings/update plus a Never-or-allowed check, removing the dead resolve calls (index.ts 5250, 19866, 19984, 18649), `dismissStale` and `cancelThread`. Drop the unused phone `macAccess`.
     - A thrown `respondToRequest` returns an "unknown" result and leaves the card open with a held note.
     - The secure-form card says some fields may have been filled when `expired && some(filled)`.
     - The thread respond route checks `liveDecisionRefusal`, so a second answer gets 409.
- **Files:** server/index.ts, server/laterdog/owner-auto.ts, server/mac-approval.ts(+test), server/system-prompt.ts, server/direct-apply.ts, server/routine-requests.ts, src/components/{ApprovalCard,PendingApproval,Sidebar,ComputerSettings,SecureFormCard}.tsx, src/locales/*, source-hashes.json. Phone: src/ui/Cards.tsx, src/lib/{settings-words,client,wire}.ts, src/state/store.tsx, src/app/settings/index.tsx.
- **Size:** L in total.
- **Depends on:** nothing. Do this before Lane 10's settings UI.
- **Overlap:** supersedes #64 (draft, red, conflicts) and the parked auto-review-switch lane. Touches the same Mac paths as #67, and overlaps the parked push-approval lane.
- **Fixture proof:**
  - `CLOUD_HOME` harness from server/laterdog/owner-auto.e2e.test.ts. A Mac-placed owner dog on Off-leash gets no card.
  - Switch on plus a scripted escalation gives one card; switch off gives none.
  - A deny reaches the fake engine as the fixed text.
  - Two sessions: the second answer gets 409.
  - 21 self `propose_routine` calls all apply with no card.
  - Use `control-laterdog ui` to screenshot the visible command and the sidebar line.
- **Unverified until live:** whether the real Claude and Codex reviewers escalate sensibly. Fixture success does not qualify a live provider. macOS one-time permissions stay as they are.

### Lane 3 (P0): Updates only on yes, with a receipt
- **Items:** L6-ask, R15.
- **Change:**
  1. Set `autoInstallOnAppQuit=false` everywhere (electron/updater.mjs:122). On macOS, stage Squirrel only after the yes: `coordinator.install(version)` sets preparing, calls `nativeUpdater.checkForUpdates()`, waits for the native update-downloaded under the existing 5-minute deadline, then calls `quitAndInstall`.
  2. `install(version)` does nothing if the staged version differs. The dialog, Settings and profile menu pass `state.version`.
  3. electron/update-receipt.mjs writes `{from, target, requestedAt}`. The next launch shows "Updated to X" or "The update to X didn't finish · Try again".
  4. The restart warning lists local dogs only when the window shows the local workspace. On Cloud it warns only when `summary.busy` says the Mac is in use.
  5. `/api/health` returns `serverVersion()`, with the image tag as `LATERDOG_APP_VERSION`.
  6. Phone Settings footer shows the short update id or "built-in", plus one line when the app launched in emergency (rollback) mode.
  7. Home drain on SIGTERM: stop new turns, wait for in-flight turns with a cap well under Cloudflare's kill deadline, then let run.mjs do its final save.
- **Files:** electron/{updater,updater-coordinator,update-receipt(new),preload,main}.mjs/cjs, related node tests, src/components/{UpdateButton,SettingsModal,SidebarProfileMenu}.tsx, src/types/laterdog.d.ts, src/locales/*, server/index.ts (health), server/laterdog/drain.ts (new), deploy/laterdog/home/Dockerfile, docs/verification/stability-sweep.md, docs/laterdog/verification.md, phone:src/app/settings/index.tsx.
- **Size:** M for L6-ask plus the guard and receipt, L with the drain.
- **Depends on:** nothing.
- **Overlap:** none open. The parked image-push-ci lane covers the image tag.
- **Fixture proof:**
  - Node tests with a fake updater: no native check before the yes; a quit installs nothing; `install('0.3.42')` with 0.3.43 staged does nothing.
  - Receipt cases.
  - scripts/sealed-update-check.sh on a sealed previous release: download, Cmd-Q, reopen on the same version. Then the yes path reopens on the new version, notarized, with data intact. A read-only disk image gives "didn't finish". Never click Restart in a non-sealed copy.
  - Drain on laterdog-home-test: long turn, SIGTERM to PID 1, the turn completes and the final save is logged.
- **Unverified until live:** how long macOS staging takes after the yes on the person's Mac. Whether Cloudflare rollouts send SIGTERM to busy homes comes from the docs and is not repo-verified.

### Lane 4 (P0/P1): Damaged data is kept; account changes leave nothing behind
- **Items:** R7, L6-signout, R3, R4.
- **Change:**
  1. **M.**
     - Add server/laterdog/owned-file.ts: `readOwnedJson`, which on damage copies the bytes to `<name>.damaged-<iso>` with mode 0600.
     - A damaged bots.json makes `needsSeed()` false. Saves are not blocked.
     - Apply the same to groups.json and routines.json.
     - Expose the state through config or health, and show one plain line in the existing notice slot.
  2. **M, Cloud home.** Copy the previous manifest to `manifests/<createdAt>.json` and keep the last N. GC keeps every blob a kept manifest references. Allow that prefix in `STATE_KEY`.
  3. **S, phone.** Stop passing the preserve hooks to `createLocalCache`, so sign-out just clears. Delete both archive files and drafts.json. Clear the image and file caches. Any archive read that remains never throws. If unsent items exist, show them as failed rather than silently archiving them.
  4. **M, desktop sign-in and sign-out.**
     - cloud-ai-accounts: `stop()` bumps a token that `run()` checks before `scheduleRetry`.
     - `connectCloudHome` captures the account id before its first await and bails if it changed.
     - `cloud-plan:signOut` returns `cloudAccountView`, and OnMyCloud shows the storageFailed and unreachable notes.
     - When the home page loads and `cloudHomeSignedIn` is false while the grant is connected, run `connectCloudHome` once and stop at reauth-required.
     - Add `cookies` to `clearStorageData`.
     - Desktop copy says "your account", not "My Cloud".
  5. **S, phone.** Sign-out makes best-effort calls to home `/api/auth/logout` and the accounts sign-out. A failed `clearConnection` shows "Couldn't finish signing out on this iPhone. Try again." The pending-home 401 goes through the renew path. Call `cloud.home(token)` on the existing foreground and reconnect path.
- **Files:** server/laterdog/owned-file.ts(+test), server/store.ts, server/routines.ts, server/index.ts, deploy/laterdog/home/runtime/sync.mjs, deploy/laterdog/home/src/state.ts, electron/{cloud-ai-accounts,main,preload}.mjs/cjs, src/components/CloudAccountSettings.tsx, src/locales/en.json. Phone: src/state/{local-state,local-cache,workspace-archive,store,drafts,local-store}.ts(x), src/lib/{message-effects,cloud}.ts, src/app/settings/account.tsx.
- **Size:** L (three PRs: server, Cloud manifests, phone and desktop accounts).
- **Depends on:** Lane 1's phone draft-owner change, or fold it in here.
- **Overlap:** parked cloud-signout and home-sync-skip lanes. #62 covers sign-in copy only.
- **Fixture proof:**
  - Vitest with a temp `DATA_DIR`: truncate bots.json. No new dog is created, the `.damaged-*` file holds the original bytes, and a missing file still seeds.
  - sync.mjs test: two snapshots leave two manifests, pruned at the bound.
  - Phone vitest: after signOut, every localStore name is gone. A damaged archive does not block launch.
  - electron/cloud-ai-accounts node test with a hanging fetch: no timer is armed after `stop()`.
  - Fake `cloudHomeSignedIn` resolving after sign-out: no navigation.
  - Isolated fixture: POST `/api/auth/logout` with a bearer, then the next call gets 401.
- **Unverified until live:** the control-plane session lifetime (the 7-day default is inferred). Whether to keep the Mac hold after sign-out is a decision (Needs the person). Only the sealed installed-app test, never the person's running app.

### Lane 5 (P1): Notifications reach the right screen
- **Items:** L6b-reply, R17, R8, L6-a11y, R3(3).
- **Change:**
  1. **M, desktop.**
     - A native Notification bridge: electron/desktop-notifications.mjs plus a `notify` bridge in `REMOTE_SAFE`, so Cloud home Macs get banners.
     - Click IPCs `openNotificationTarget`.
     - On macOS, Reply sends through the existing send path with a fresh sendId.
     - On macOS, hide the window on close, and let live-events reconnect while hidden in Electron.
     - Export `replyable(kind)` from shared/notification.ts and use it in the push and the banner.
  2. **S, server.**
     - Push data gains `groupId` and the home `origin`.
     - Room pushes get no reply category for now.
     - The phone ignores a tap or reply whose origin differs (a missing origin counts as current).
  3. **M.**
     - Shared badge rule shared/unread-badge.ts: non-hidden dogs with an unread non-routine task or waiting on you, plus unread groups. Use it in src/App.tsx, in phone home.ts, and as `badge` on Expo pushes.
     - The phone withdraws presented pushes for read threads when the app becomes active or markRead runs.
     - Replay filter: a pure function over the replay buffer drops a notify frame when a later buffered bot or group frame shows that thread was read.
  4. **M.**
     - A presence lease tied to the SSE client entry: POST `/api/presence {streamId, threadId|null}`, released on disconnect.
     - `notify()` skips the phone push for a thread an active client is viewing.
     - Hooks: the phone's existing `useFocusEffect` and `watchingThread`; desktop focus plus the visible thread.
  5. **S, phone.** `useReplyAnnouncer` uses `AccessibilityInfo.announceForAccessibility` on the busy-to-idle edge.
  6. **L, phone native.** `opensAppToForeground:false`, a background notification task (expo-task-manager, `UIBackgroundModes` remote-notification) that POSTs with a sendId derived from the notification id and falls back to the outbox. Mark a reply key as seen only after it is queued.
- **Files:** electron/{desktop-notifications(new),main,preload}.mjs/cjs, src/lib/{notify,live-events}.ts, src/state/store.tsx, src/App.tsx, shared/{notification,unread-badge}.ts, server/laterdog/{phone-push,notify-replay(new),presence(new)}.ts, server/index.ts. Phone: src/lib/{push,push-reply,push-reply-task(new),reply-announcer(new)}.ts, src/app/_layout.tsx, src/state/home.ts, app.json, package.json.
- **Size:** L. The desktop half and parts 2-5 ship first; the phone native build comes last.
- **Depends on:** nothing. Part 6 needs a native build.
- **Overlap:** parked push-approval lane. #68 is Universal Links; coordinate the origin field.
- **Fixture proof:**
  - Node test with a fake Notification class emitting click and reply.
  - A packaged-mode window against the fixture: close the window, run a turn, see a native banner, reply, and confirm one sendId with the window still hidden.
  - presence.ts tests plus an injected push fetcher: viewing A means no push for A and one push for B.
  - Replay test: done-then-read is dropped; done and still unread is kept; approvals are kept.
  - Phone unit tests for the announcer and the badge rule.
- **Unverified until live:**
  - Banners on the real Cloud origin. Use the test home (`*-hometest.later.dog`) before the person's.
  - Whether a Lock Screen reply on a killed app reaches the task (expo-notifications 57 is unverified).
  - Push latency on a real iPhone.

### Lane 6 (P1): One roster on every screen
- **Items:** R10, L6b-exchange, R11, L6-cache, L6b-hide.
- **Change:**
  1. **S-M.** Optional `createId` on POST `/api/bots`, journaled with a 24 h limit like server/boat-create-idempotency.ts. `hello:true` runs `sayFirstHello` on the server, keeping its guards. Drop the second hello call on D and P.
  2. **M.** Phone exchange screen `exchange/[groupId]?threadId=` using `client.messages`. Fold consecutive exchange rows with the desktop's wording rules. Read-only footer, no composer. Does not need group state.
  3. **L.** Phone groups: group and group.deleted frames, groups kept from `BotsResponse`, room rows in the home list, search and unread, and a room chat that posts to the group send route.
  4. **M.**
     - `store.reorderSections` plus an order route emitting the existing sections frame. Send only real pack names, and migrate the local key once.
     - Drop the `chiefOfStaff` exclusion in sidebar-layout.ts:111 and the unused `UNIVERSAL_PINS` code.
     - A server `main` flag computed from visible dogs (shared/main-dog.ts, visible chief first in sidebar order, else the oldest visible dog), used by both clients.
     - Desktop last selection in per-origin localStorage, falling back to the main dog and never to a hidden dog.
  5. **L.**
     - Hidden becomes a list filter only. One "dog can act" predicate replaces the hidden gates in peer messaging, rooms, hand-offs, routines, peer-roster.ts:91, group-goal-run.ts, external-runtime.ts:55, routes/hosted-slack.ts:15 and store helpers. Keep the Chief checks.
     - Desktop renames Archive/Restore to Hide/Unhide and adds the footer row and three-line help.
- **Files:** server/index.ts, server/store.ts, server/laterdog/first-hello.ts, server/peer-roster.ts, server/group-goal-run.ts, server/external-runtime.ts, server/routes/hosted-slack.ts, server/laterdog/{dog-creation,group-chats}.ts, shared/{wire,main-dog}.ts, src/state/store.tsx, src/lib/{sidebar-layout,sidebar-preferences,last-selection(new)}.ts, src/components/Sidebar.tsx, locales. Phone: src/lib/{wire,client,transcript-items,chat-row,home-search}.ts, src/state/{reducer,home,store}.ts(x), src/app/{dogs,exchange/[groupId]}.tsx, src/ui/{HomeParts,ChatEvent}.tsx.
- **Size:** L (five PRs).
- **Depends on:** nothing. The phone group rows follow phone #11.
- **Overlap:** phone #11 ("group activity on the phone") overlaps phone groups and the exchange screen, so land or rebase on it first. #70 touches activity rendering. The parked codex-numbered lane, if it touches rows.
- **Fixture proof:**
  - Two POSTs with the same `createId` add one dog. `/api/events` shows the seed greeting, then the fake first question with no extra call.
  - A room made by the fake create_room tool emits a group frame. The phone reducer and buildHome tests list it.
  - Drag a pack headless: GET `/api/sidebar-sections` returns the new order and the local key is gone.
  - Hide B: A's coordinate_bots request to B is delivered, a room mention gets a reply, and run-now creates a run.
  - Reload restores the last chat; `'{bad'` opens the main dog.
- **Unverified until live:** phone rows side by side with the Mac on the person's iPhone.

### Lane 7 (P1): The Cloud home is the workspace: opens fast, wakes quietly, errors stay in place
- **Items:** L6-paint, L6-scoped, R12, R22(1,3,4).
- **Change:**
  1. **S.** One `reportError(e, pane?)` built on showError replaces the 9 raw `{type:'error'}` dispatches, so wording and clearing are the same everywhere.
  2. **M.** Pane-keyed errors (sidebar, chat:<threadId>, dogPanel:<botId>, routines), cleared when the pane's own retry succeeds or its refresh succeeds after the stream reopens. Extend `loadPeripheral` to instances and config. The phone `chatNotice` shows only for cause 'other' when rows exist. Move `StatusBanner` errors into the screen that raised them.
  3. **M.** src/lib/first-paint.ts snapshot (owner = origin plus account, about 2 MB, written after a real hydrate, restored before loadAll). The splash lifts on restored or hydrated. A lighter boot page per dog, then the selected thread's full page.
  4. **L.**
     - The home Worker serves the renderer's static bundle, so the page loads while the container sleeps.
     - The API's existing 503 JSON drives a quiet "Waking up…" line over the cached sidebar.
     - Replace both This-Mac fallbacks (did-fail-load in main.mjs:1898-1911 and `windowChoice` in electron/cloud-window.mjs:6-8) with staying on the home origin, retrying, and showing "Couldn't reach your home · Try again".
  5. **M.** Failed turns get an optional `reason`, computed once in the central runtime.error handler with `classifyError` and stored on FailedTurnTool. One shared `failureView(tool)` for desktop FailedTurnRow and phone ChatEvent, with phone Retry and Continue on, and Sign in and Update opening the existing screens. Remove the desktop string matches. Dedupe only within one turn.
  6. **S.** The home Worker keeps or mints `x-request-id` (cf-ray or UUID), echoes it including on wake responses, and the container logs it. traceparent passes through. cloud-account.mjs errors carry status, retry-after and request id. The phone honours a 429 retry-after once.
- **Files:** src/state/store.tsx, src/lib/first-paint.ts (new), src/components/{LaunchSplash,ChatView,Sidebar,GroupView,CloudQuietLine,LimitRow}.tsx, src/App.tsx, electron/{main,cloud-window,cloud-account}.mjs, deploy/laterdog/home/src/{index,host,waking}.ts plus static-asset config, shared/failed-turn.ts, shared/failure-view.ts (new), server/index.ts. Phone: src/state/connection.ts, src/ui/{StatusBanner,ChatEvent}.tsx, src/lib/{chat-row,waking}.ts.
- **Size:** L (six PRs).
- **Depends on:** Lane 1's shared/home-wake.ts. Part 4 needs the person's answer on the local workspace.
- **Overlap:** #49 (old dev Cloud client, likely to close). Parked stale-copy-desktop, status-lines, home-crash-resilience and home-stay-awake lanes. #59 (large home).
- **Fixture proof:**
  - Headless driver (docs/verification/chat-ui.md): reload with the fixture stalled. The sidebar and chat paint from cache with no splash, and the hydrate then replaces it.
  - `kill -STOP` for 25 s: no banner.
  - Fixture route flags making routines and one thread return 500: each pane shows its own Try again and clears on resume.
  - Electron node test: did-fail-load never calls `switchEnvironment(LOCAL_ID)`.
  - `FAKE_CLAUDE_MODE=api-error` and `usage-limit`, set through env because they are not in FAKE_MODES: one failed row with the right action, on both clients.
  - deploy/laterdog/home/test with fake-containers.ts: request id kept or minted, and the static page is served while asleep.
- **Unverified until live:** Worker static assets on the production home, and cold-wake timing on the person's real home.

### Lane 8 (P1): Routines, computers and Mac tools behave
- **Items:** R24, R9, L6-faces, R21b, R21a(2-3), L6b-plugins.
- **Change:**
  1. **S, ship first, high impact.** When signed in to Cloud, the desktop does GET then PUT `/api/time-zone` with the Mac's zone whenever it differs. Last writer wins.
  2. **S.** RoutinesCard shows one last-run line from `state.routineRuns` (`latestRoutineRun` and `routineRunLabel` already exist) and opens that run's thread. The server returns `scheduleLabel` (`cronScheduleLabel`), and the phone shows it instead of "Custom schedule".
  3. **M.** A quiet preview screenshot (`?preview=1` from the route's existing `previewOnly`, through screenshotBoat and cloud-computers.ts) skips `markActive` and `inFlight`. ComputerTab re-reads `/computer` once after a provision error. The awake loop re-reads status when a screenshot fails after the first frame and drops to asleep or waking. Phone "Reconnecting…" caption.
  4. **S.** viewer.ts holds the last canvas in a dimmed layer with pointer-events off while reconnecting, and drops it on connect, on finish or after N failures.
  5. **M.** Register `computer` only when macOS accessibility and screen are granted, with an optional screen state in the registration schema. Busy returns the existing `{code:'busy'}` 409 plus `retryAfterMs`, with a small queue in server/laterdog/mac-queue.ts. Reads run in parallel and screen actions one at a time. Electron's single executing slot must also allow parallel reads.
  6. **M.** server/laterdog/connections.ts read-only list (state plus cached tool names, no skills, never probing on open). One "Adds:" line on the desktop rows. Phone Settings › Connected apps (read-only).
- **Files:** src/lib/time-zone-sync.ts (new), src/components/bot-settings/{RoutinesCard,ComputerTab}.tsx, server/routines.ts or the routine list route, deploy/laterdog/computers/src/{computer,index,viewer}.ts plus tests, server/{computers,index}.ts, server/laterdog/{cloud-computers,mac-queue(new),connections(new)}.ts, server/shared-computers.ts, electron/{computer-sharing,mac-permissions}.mjs, src/components/{McpConnectorCards,PluginsPanel}.tsx. Phone: src/lib/routines.ts, src/lib/computer/stage.ts, src/ui/dog/ComputerTab.tsx, src/app/settings/connected-apps.tsx (new).
- **Size:** L (six PRs; part 1 is S).
- **Depends on:** Lane 2 for the routine cap and card removal.
- **Overlap:** #58 vm-kiosk (viewer and wake) overlaps parts 3-4, so rebase on it. #67 overlaps part 5. Parked cloud-dogs-mac and github-connect lanes overlap part 6.
- **Fixture proof:**
  - Renderer fixture with `TZ=Asia/Kolkata` signed in: GET `/api/time-zone` returns Asia/Kolkata, and a daily 09:00 routine's next run is 09:00 Kolkata.
  - Computers tests with fakes.ts: a quiet preview leaves `lastActiveAt` unchanged, and exec still resets it.
  - ComputerTab.test.ts: provision rejects, status says running, the card ends awake.
  - viewer.test.ts string assertions for hold and drop.
  - lending-guards node test with permissions denied registers `computer:false`.
  - Two `computer_call`s run in sequence; past the bound returns code busy.
  - MCP sign-in fixture: Needs sign-in becomes Added, with cached tools.
- **Unverified until live:** the home image's default zone (UTC is inferred), the real idle sleep on a deployed computer, and macOS permission changes on the person's Mac.

### Lane 9 (P1, security, needs a second reviewer): Secrets stay sealed; forms offer the screen
- **Items:** R14, L6b-forms.
- **Change:**
  1. One `SECRET_FIELDS` table in server/config.ts used by both `syncCredentialEnv` and blanking, so every key including provider keys is covered.
  2. On the Cloud home, always seal: AES-256-GCM under HKDF from `CLOUD_HOME.bootstrapSecret`, which never reaches R2. Unseal before loadConfig, migrate existing plaintext once and atomically, and show "Saved sign-ins are locked" on unseal failure.
  3. Write the `ldt_` key outside the synced tree, or skip it.
  4. mcp-gate child env comes from an allowlist (PATH, HOME, USER, LANG/LC_*, TMPDIR, proxy vars) plus `spec.env`.
  5. Desktop with no OS encryption: memory-only, `storage:"session"`, and the card says "Saved for this session only".
  6. Phone key card posts to `/api/config`, then `secret-cards/:id/provided`.
  7. Forms: POST `/api/bots/:bot/secure-forms/:id/screen` clears the vault, sets status to 'screen', and resumes the dog with one line. The dog decides whether to call `request_takeover`. One quiet button on D and P opens the computer view. Copy says only masked fields are hidden from screenshots. Show the host in the desktop card subtitle. Drop the "desktop app" fallback copy.
- **Files:** server/config.ts, server/laterdog/sealed-secrets.ts (new), server/cloud-home-start.ts, server/index.ts, server/mcp-gate.ts, deploy/laterdog/home/runtime/included.mjs, electron/main.mjs, src/components/{SecretRequestCard,SecureFormCard}.tsx, server/laterdog/secure-form.ts, server/routes/secure-forms.ts, shared/secure-form.ts, locales. Phone: src/lib/{secure-request,secure-form,client}.ts, src/ui/{SecureRequestCard,NativeSecureForm}.tsx.
- **Size:** L.
- **Depends on:** nothing.
- **Overlap:** none open.
- **Fixture proof:**
  - Node test booting the config path with a fake bootstrap secret in a temp `DATA_DIR`. After PUT of a dummy key, `rg -F` finds nothing on disk, `configured:true` holds, and a restart unseals it.
  - mcp-gate fake upstream prints its env: no `*_API_KEY` and no `LATERDOG_HOOK_*`.
  - safeStorage stub returns session storage.
  - secure-form.test.ts: `/screen` empties the vault and resumes.
  - A seeded form message in the fixture (no real `request_secure_form` without a cloud computer).
- **Unverified until live:** whether the dog's shell runs as the same uid as the server on the Cloud home. If it does, sealing protects the R2 backup but not a dog that runs `cat`, so the copy must not promise more.

### Lane 10 (P2): Plain-surface polish: links, voice, settings, usage
- **Items:** R16, L6-strict, L6b-linklog, L6b-memo, L6-dictation, L6b-callrecord, R18, L6-settings (UI), R20, R19.
- **Change (separate S/M PRs):**
  - **Links (M):**
    - shared/app-link.ts parses and builds dog, chat and settings(section), accepting both the thread and chat forms.
    - Desktop: one latest-wins slot in main plus preload replay to `onAppLink` (in `PROFILE_KEYS`). The renderer routes through `openNotificationTarget` and `toggleAppSettings(section)`, and App.tsx:141 is fixed to pass the section.
    - A missing dog shows "Not found. This dog was removed or isn't shared with you."
    - Phone: `safeMessageLink` allows `laterdog://`. Native-intent returns '' when warm and '/' when cold. Add a `+not-found` route.
    - Link and external-open failures are logged as scheme and host only (desktop slog; a phone ring of 20 entries added to feedback details).
  - **Voice (M each):**
    - Phone VoiceNote component with bars and m:ss. Desktop bar row. The server keeps `durationMs`.
    - Esc cancels dictation. Visible "Transcribing…" status. Take-turns Mute. Drop the "This computer" copy.
    - server/laterdog/speech-cache.ts bounded LRU for `/api/tts/speak`. Desktop Live step stamps in `/api/live/call/end`. A queued note after the receipt.
    - Call record (L): optional `call {id}` on sends, through the phone store, the outbox and the server FollowupPayload. Reuse the phone callId. A "Voice chat · m:ss" fold row. Rating by reactions.
  - **Settings (L):**
    - Four desktop sections: fold Models into Accounts.
    - "Usage & Billing" with the plan row and "Billing is on later.dog. Manage opens it in your browser."
    - One update switch.
    - The single Auto-review switch replaces the per-dog pickers (after Lane 2).
    - Plain words instead of "My Cloud", including the home wake page.
    - Phone Plan row from the entitlement (add it to the `CloudAccount` type).
    - Ink meters.
    - `AccountUsageCard` renders nothing for a failed provider.
    - CloudTrial shows "resets {date}".
  - **Flags (S):**
    - `analyticsEnabled` returns false on storage errors.
    - Delete `identifyEmail`.
    - Ship or delete skillsLibrary, routinesInConversation and sharedComputers.
    - Diagnostics add a redacted home log tail.
- **Files:** see the per-item lists in the map. Most are under src/components, src/lib, electron/main.mjs, electron/preload.cjs, server/index.ts, shared/, and the phone's src/lib, src/ui and src/app.
- **Size:** L in total.
- **Depends on:** Lane 2 before the settings UI. Lane 7 before the "My Cloud" strings.
- **Overlap:** #68 (Universal Links, web app). Parked legal-support, included-ai-models and stale-copy-desktop lanes.
- **Fixture proof:**
  - Dev variant (`laterdog-dev` scheme, own data dir, fixture server): `open 'laterdog-dev://chat/<bot>?thread=<id>'` cold and warm; `chat/missing` shows the not-found words; `settings?section=usage` opens Usage.
  - Export diagnostics shows link lines with no query text.
  - `xcrun simctl openurl` against an Expo Go fixture.
  - ui eval: voice note with bars and a duration; Esc restores the earlier text.
  - Two sends with call c1 make one fold row.
  - Settings shows 4 nav items, one update switch, and no Heel/Off-leash or "My Cloud" strings.
- **Unverified until live:** App Store review of the billing sentence outside the US storefront. Whether apple-app-site-association is served for `*.later.dog` (not in this repo).

**Not laned:** L6-switch, L6b-mail and L6b-rules step 3 wait on Needs the person. R23 is done.

## 5. Needs the person

1. After signing out of Cloud on the Mac, should the Mac's own pre-move dogs stay paused, or start running again as they do today?
2. Should the Auto-review switch be flipped to its literal meaning for every existing dog on upgrade (on = AI reviewer decides and cards only for escalations; off = no asks)?
3. Do you want plain-sentence Auto-review rules ("Ask me before anything that sends email"), or just the one switch?
4. Do you actually use a second later.dog account, so that a plain account list for switching is worth building?
5. Should dogs get their own email address? If so, will you do the Email Routing and DNS click for a later.dog mail subdomain?
6. Can the 100-dog workspace cap and the 4-dogs-per-turn cap be removed for your own workspace?
7. Should a hidden dog keep working fully, as the phone copy says (hidden is just a list filter)?
8. When the Cloud home cannot be reached, should the Mac show "Couldn't reach your home · Try again" instead of falling back to the Mac's own dogs, and should the "not now" local-workspace path go away entirely?
9. On iOS, should billing be one plain sentence ("Manage your plan at later.dog") with no link?
10. Will analytics ever ship with a token, or should the analytics code be deleted?
11. For Cloud image deploys, is "the interrupted turn resumes later" good enough, or should we build the shutdown drain and test the busy-aware rollout policy on laterdog-home-test?
12. Is a new phone native build through TestFlight OK for background Lock Screen replies?

## 6. Coverage notes

- **Nothing was run.** No build, test, fixture or device check was done; every verify step is a plan. The open PRs were matched by title only, not diffed. The 28 parked lanes were matched by name from #69's list.
- **Unverified claims carried forward:**
  - better-auth's default 7-day session.
  - Cloudflare rollouts sending SIGTERM to busy homes.
  - The home image's default zone being UTC.
  - Whether the phone closes its SSE stream when backgrounded.
  - Whether Expo's `File.write` is atomic.
  - Phone cold-launch reply loss, and where a room push lands.
  - Whether expo-notifications 57 delivers an action to a killed app.
  - Whether phone sessions may remember commands (test evidence only).
  - Whether the dog shell runs as the server's uid on the Cloud home.
  - Whether apple-app-site-association is served for `*.later.dog`.
  - Whether Claude auto mode accepts deny-type rules and the Codex reviewer accepts user policy text.
  - The durable_object scheduling policy (beta, needs a new container app; never PATCH an existing container Worker).
- **Tooling gaps found:**
  - `control-laterdog` cannot reuse a data dir, so R7 relies on unit tests.
  - The `FAKE_MODES` list lacks api-error and usage-limit (pass them through env).
  - deploy/laterdog/computers has no DOM test environment (string tests only).
  - electron/window-state.test.mjs is vitest, not node:test.
  - A real `request_secure_form` needs a cloud computer the fixture lacks.
- **Study scope:** only REPORT.md and the system NOTES.md "what later.dog takes" sections were used. Ideas that are not in those sections are not covered here.