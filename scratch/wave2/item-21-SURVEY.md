# Lean-code survey (read-only), 2026-11-13

Nothing was edited, committed or installed. Phone worktree `git status --short` was empty before and after (checked repeatedly; two of my own scratch files were written into it by a relative-path slip within seconds and moved out at once, never staged: `git status` clean afterwards).
Desktop worktree `/Users/jacoblopez/code/.wt/fable-lean` at 216b6e19a; phone `/Volumes/fable-native/wt/phone-release` at 336a69d.
Full lists: `desktop-candidates.tsv` (248 rows) and `phone-candidates.tsv` (72 rows) in this folder (path, kind, lines, evidence, confidence).

Notes on method and limits
- Two independent finders per repository: knip (entry points in `knip-*.json` here) and my own import-graph and export scripts (`graph.mjs`, `exports.mjs`, `styles.mjs`, `locale.mjs`). Knip agrees with my graph on every phone file candidate and on 23 of 29 desktop whole-dead exports (the other 6 are file-level candidates or entry files knip does not report exports for).
- The desktop run of knip printed `Cannot find module '@cloudflare/vitest-plugin'` for the `cloudflare/control-plane` workspace config (not installed in the shared node_modules). It still produced a full report, but treat knip's view of `cloudflare/` as incomplete (out of scope anyway).
- The desktop has no `native/` directory in this worktree; `server/routes/` has no dead file.
- "Root" in the desktop evidence means the file already existed in the 0.2.0 import commit 082fce401 (the squashed fork base), so it may be upstream's; history is squashed, so author checks are useless (every file is by woodbeary). "Added after import" means first-party.
- Lines are `wc -l` of the file, or the line span of the declaration for an export. They are estimates of removable lines, not diffs; removing an export can also leave an unused import or type behind.

## Phone app

| kind | count | removable lines |
|---|---|---|
| files nothing imports (high) | 5 | 240 (Chrome.tsx 65, SearchHeader.tsx 75, SearchFilterButton.tsx 52, SearchFilterMenu.ios.tsx 43, SearchFilterMenu.tsx 6) |
| orphan route (medium) | 1 (+1 line in settings/_layout.tsx) | 66 (`src/app/settings/macs.tsx`) |
| whole functions/consts with zero references | 15 | 58 |
| exports referenced only by tests (the tests would go with them) | 35 | 228, plus their test cases |
| StyleSheet keys never read | 4 | 4 (MessageItem chip, chipText; ModelSheet strong, figure) |
| script nothing names | 1 | 58 (`scripts/sim-audit.sh`) |
| assets nothing names | 5 | binary (android-icon-*.png x3, icon.svg, splash-dog.svg) |
| dependencies | 0 truly unused | see below |
| exports used only inside their own file (un-export, no line removal) | about 284 | 0 |

Total removable, excluding the un-export-only group: about 650 lines (about 420 if the test-only exports are left alone). The phone is already lean: knip finds only 14 unused files and 3 of them are dead (the other 11 are the dev gallery, see below).

Top candidates by size, with evidence
1. `src/ui/SearchHeader.tsx` (75) - `git grep SearchHeader` hits only itself; search screen is `src/app/search.tsx`. Its helpers `SearchFilterButton`, `SearchFilterMenu(.ios)` are imported only by it. Knip flags SearchHeader and SearchFilterMenu.tsx; my graph also sees the other two (platform-suffixed files that knip resolves differently).
2. `src/app/settings/macs.tsx` (66) - no `router.push`/`href`/deep link names `/settings/macs` (git grep); only a `Stack.Screen name="macs"`. `src/ui/MacAccessGroups.tsx` renders the same choices. Medium: expo-router serves the URL, and `docs/verification-phone.md` still calls it "Your Macs".
3. `src/ui/Chrome.tsx` (65) - no importer; the live one is `src/ui/computer/Chrome.tsx`. Knip agrees.
4. `scripts/sim-audit.sh` (58) - no package.json script, test, doc or script names it.
5. `src/ui/SearchFilterButton.tsx` (52), 6. `SearchFilterMenu.ios.tsx` (43) - see 1.
7-20. Exports used only by tests: `composer-geometry.ts#chatGeometry` (30), `ima-adpcm.ts#decodeAdpcm` (19), `usage-sheet.ts#usageSheet` (15), `voice-call.ts#activityAfter` (12), `usage.ts#monthRange` (9) and `usageDays` (8), `progress-runtime.ts#nextHelperChange` (9), `plan-usage.ts#usageGlance` (9), `cloud-storage.ts#cleanupNote` (9), `model-choice.ts#selectionLabel` (8), and the whole-dead `ui/Icons.tsx` MicIcon (8), PersonIcon (8), EllipsisIcon (9). Evidence: name search over every tracked ts/js file finds them only in `test/` (or nowhere for the Icons).

Whole-dead with zero references: `cloud.ts` CLOUD_PLAN_NOTE and SETUP_WORDS, `live-dictation.ts#useHasLiveDictation`, `model-menu.ts#tightestWindow`, `teammate-ask.ts#teammateAsk`, `voice-wave.ts` SPEAKER_LOOKAHEAD_MS and SPEAKER_RESCAN_MS, `wire.ts#dogBubble`, `state/connection.ts#isBusy`, `state/home.ts#GRID_COLUMNS`, `ui/computer/ActionBar.tsx#barHeight`, `ui/theme.ts#onInk`, Icons x3. (`teammate-ask.ts` may then be an empty file: check at removal.)

Unsure
- `src/lib/native-run-selectors.ts` exports (nativeActorRole, actorAncestry, applyNativeRun, nativeReceiptAnchors): unused here, but the file is GENERATED from the desktop `shared/native-run-selectors.ts` by `scripts/sync-native-contract.ts` and `test/native-runs.test.ts` compares them. Do not edit; trim at the source. Marked low.
- `src/app/+native-intent.tsx#redirectSystemPath`: expo-router special export, used at run time (a test imports it). Not dead.
- Assets: android-icon-*.png, icon.svg, splash-dog.svg are unreferenced (`app.json` has `android: {}`), but may be kept as design sources.
- `expo-splash-screen` (knip dependency finding) is an `app.json` plugin: needed by the native build. `@expo/metro-runtime`, `react-native-web` serve the web target used by visual-audit/probe. `expo-file-system` is imported in 11 files but not listed in package.json (knip "unlisted"): a real inconsistency to look at, not dead code. No dependency is safe to remove.
- Tests that "test only dead code": none found whole. Each test file also covers live code; only the test cases for the 35 test-only exports would go.

Looks dead, reached at run time (do not remove)
- `src/dev/gallery/*` (11 files, about 1,100 lines), `Gallery.tsx` has no importer: `scripts/visual-audit.mjs` writes a route file `export { default } from "../dev/gallery/Gallery"` at run time; `scripts/composer-soak.mjs` and `test/phone-screens.test.ts` use it. `src/dev/frames.ts`, `gallery-scope.ts`, `everything-reply.ts`, `Probe.tsx` are used by `__DEV__` hooks and tests.
- Platform variants (`*.ios.tsx`, `*.native.tsx`) that bare-path imports hide from file-level tools: AttachMenu.ios, ChatMenu.ios, ConsoleMenu.ios, PhotoShrinkHost.native etc.
- Route files under `src/app/**` all have a Stack.Screen and a link except macs; `settings/hidden`, `computer/help`, `choose-main-dog`, `viewer`, `preview` are opened by `router.push` strings or `open-preview.ts`.
- `scripts/` files named in docs or tests: composer-soak, probe*, fixture-smoke, audit-seed, build-novnc, sync-native-contract, visual-audit, ota-beta.sh.

## Desktop / server repository

| kind | count | removable lines |
|---|---|---|
| files (manual scripts, 3 unused sources, 2 test fixtures) | 15 | 1,061 |
| whole functions/consts with zero references | 27 | 326 |
| exports referenced only by tests | 54 | 489, plus test cases |
| locale strings in `src/locales/en.json` unused | 151 | 151 in en.json, about 1,350 more across the 9 translated files; needs `pnpm i18n:check` / regeneration and `source-hashes.json` |
| dependencies | 2 (`@radix-ui/react-icons`, `qrcode.react`: zero mentions outside package.json and the lockfile) | 2 |
| exports used only inside their own file (un-export only) | about 530 | 0 |

Total removable, excluding un-export-only: about 2,050 lines if everything is taken (about 1,350 without the test-only exports and locale strings). Knip finds only 37 unused files in total in the repo, 2 of them in scope and real; the dead file count is small because `server/laterdog/*` files are all imported.

Top candidates by size
1. `scripts/e2e-server.mjs` (228) - no package.json script, test, doc or script names it. Root: may be upstream's.
2. `scripts/testing/fake-vnc-desktop.ts#fakeVncDesktop` (137) - zero references to the name. Root.
3. `scripts/build-npm-package.mjs` (136) - zero references anywhere. Root.
4. `scripts/smoke-app-permissions.mjs` (113), 5. `scripts/smoke-deb-upgrade.mjs` (108, only self-mentions), 6. `scripts/verify-group-vm.ts` (101; the team/room features it targeted were removed 10-18), 8. `scripts/regenerate-mac-feed.mjs` (63), `scripts/verify-codex-surface-live.ts` (43), `scripts/regenerate-blockmaps.mjs` (24) - none referenced by anything. All root.
7. `src/components/ApiKeys.tsx#OpenCodeProviderKeys` (98) - only tests mention it. Root.
9. `server/testing/fake-agy-cli.ts` (74) - no reference to the file or its FAKE_AGY_* variables outside itself. Root.
10. `scripts/testing/png.ts#decodePng` (51) - zero references. Root.
11. `scripts/ci-scope.mjs` (49) - only its own test and a shard-weights json name it; no workflow calls it. Low.
12. `src/components/AttachmentPreview.tsx#AttachedImageGallery` (36) - test-only.
13. `scripts/measure-tool-loading.ts` (31) - no reference; first-party, added 11-12 (maybe a work in progress of another builder).
14. `src/lib/schedule-label.ts#scheduleSentence` (29), `src/components/ConnectionDetail.tsx#ConnectionDetail` (28) - test-only. `server/testing/peer-approval-hooks.mjs` (27) - nothing loads it. `server/laterdog/trace-state-fake.ts#FakeTraceState` (24) - test-only fake in a non-test file.
15. `shared/new-bot-defaults.ts` (36), `src/components/CloudOwner.tsx` (15, `useCloudOwner`) and `DiscordIcon.tsx` (15) - zero references; knip and my graph agree. High. After CloudOwner goes, `lib/session.ts#cloudOwnerOf` is used only by its own test.
16. `server/laterdog/tool-loading.ts#CORE_AGENT_TOOLS` (19, first-party, test-only), `src/lib/computer-control.ts#transitionBrowserControlLease` (19) and `heldComputerControlBotIds` (7), `src/components/EngineSetup.tsx#EngineWarningNotice` (22), `src/components/SettingsPrimitives.tsx#CommandLine` (19), `shared/provider-icon.ts#PROVIDER_ICON_LABELS` (15) - zero references.

First-party (added after import) whole-dead names, safest to take first: `deploy/laterdog/computers/src/gateway.ts#TIERS`, `mcp-tools.ts#KEY_MAX_CHARS`, `server/laterdog/laterdog-cloud.ts#SECRET_ENV_NAMES`, `shared/cloud-task.ts#CLOUD_TASK_STAGES`, `shared/device-approval.ts#deviceApprovalActionPath`, `src/lib/cloud-tasks.ts#refreshCloudTask`, `src/lib/dog-refs.ts#dogRefOf`, plus test-only first-party ones (`engine-remote.ts#commandLink` 14, `long-work.ts#ownerAutoWork`, `engine-trim.ts#OFFERED_DRIVERS`, `claude-refresh-lock.ts#CLAUDE_REFRESH_LOCK_STALE_MS`, `shared/helpers.ts#withoutSettledHelpers`, `shared/work-state.ts#WORK_PRIORITY`, `shared/cloud-task.ts#lastMeaningfulStep`, `src/lib/helpers-state.ts` x2, `reload-guard.ts#reloadsHeld`, `sharper-dictation.ts#sharperTranscript`, `unread-pill.ts#unreadBelowCount`).

Unsure
- Everything marked root may be upstream's; the fork merges upstream, so removing these now will conflict later. Most are manual scripts a maintainer may still run by hand.
- Locale keys: unused by every literal and template-prefix search, but a key built as `a + "." + b` would not be seen. Keys are also in `source-hashes.json` and 9 locale files; remove only through `scripts/generate-locale.mjs`.
- `shared/new-bot-defaults.ts` (36): type-only, nothing imports it (the `server/new-bot-defaults.ts` that config.ts and index.ts import is a different file). Medium only because it is root.
- `server/laterdog/trace-state-fake.ts` and other "fake" helpers in non-test files are test fixtures, not dead.

Looks dead, reached at run time (do not remove)
- Spawned processes listed in `scripts/bundle-server.mjs`: `server/connector-proxy.ts`, `mcp-gate.ts`, `mcp-remote-proxy.ts`, `permission-proxy.ts`, `local-computer-proxy.ts`, `pair-cli.ts`, `hooks/laterdog-hook.ts` (also named in `deploy/laterdog/home/codex-requirements.toml`), `server/laterdog/main.ts` (scripts/laterdog.mjs, dev-desktop.mjs, release script), `engine-proxy.ts`, `engine-relay.ts` (loaded by name in `engine-computer.ts`), `archive-descriptors.ts`, `cloud-home-start.ts`.
- `server/testing/desktop-parent.mjs`, `group-local-vm-hooks.mjs`, `hold-search-result.ts`, `fake-pi-cli.ts`, `setup.ts` (vitest setup): loaded by path in tests/evals.
- `src/testing/*.tsx` and `scripts/testing/*-preview.tsx`, `dictation-escape.js`, `voice-button.js`: loaded by Vite as `entry: "/src/testing/..."` strings in verify scripts and docs.
- `src/novnc.d.ts`, `src/types/laterdog.d.ts`: ambient declarations picked up by tsconfig.
- `drivers/agents-proxy.ts`: used by name from tests and docs.

## Commands run
```
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
# phone (cwd /Volumes/fable-native/wt/phone-release)
/Volumes/fable-native/tmp/heavy.sh nice -n 10 pnpm dlx knip --no-progress --directory /Volumes/fable-native/wt/phone-release --config /Volumes/fable-native/tmp/t/lean/knip-phone.json --reporter json
  (same with knip-phone-notest.json: tests removed from entries)
# desktop (cwd the fable-lean worktree)
/Volumes/fable-native/tmp/heavy.sh nice -n 10 pnpm dlx knip --no-progress --directory <worktree> --config .../knip-desktop.json --reporter json
  (and knip-desktop-notest.json)   [runrest.sh runs these under one lock]
node graph.mjs <root> x '<entry regexes>' <out.tsv>      # import graph, with and without tests as entries
node exports.mjs <root> '<scope regex>' <repo>/package.json <out.tsv>   # exported function/const/class with no outside reference
node styles.mjs <phone> <phone>/package.json <out.tsv>   # unread StyleSheet keys
node locale.mjs                                          # en.json keys vs all source text
node mk.mjs                                              # writes the two candidate TSVs
git grep -n -F/-w <name>  (per candidate); git log --diff-filter=A; git cat-file -e 082fce401:<path>
git -C /Volumes/fable-native/wt/phone-release status --short   # empty at the end
```
