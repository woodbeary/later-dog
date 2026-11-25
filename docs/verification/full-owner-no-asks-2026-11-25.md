# Full access without routine approval cards

An owner's Full access turn completes routine work without a permission or question card. The decision uses the source chat's effective mode and owner authority; a dog's saved default does not upgrade an Ask chat, a guest turn or a shared workspace.

## Decisions

| Action                                                                                                         | Owner Full behavior                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cleanup inside the dog's workspace, task folders, temporary folders and existing cache allowance               | Resolve known command assignments and home, working-folder and temporary-folder values; proceed when the target stays inside the allowed folders |
| Unknown delete targets, paths outside those folders, protected roots, repository roots and links that lead out | Refuse to the dog with a concrete reason and a literal-path recovery where appropriate; no approval hold                                         |
| A protected push or hook edit that bypasses checks                                                             | Refuse to the dog; run checks and rewrite the operation                                                                                          |
| Credential settings and authorized account changes                                                             | Proceed through the existing account and tool scopes                                                                                             |
| Connected-app changes that delete or share                                                                     | Proceed within existing scopes; remote repository deletion and unreadable proxy code remain refused                                              |
| Sends in the person's name and payments                                                                        | Keep per-action confirmation; saved access does not cover them                                                                                   |
| Questions                                                                                                      | Pick the recommended option, otherwise the first option, immediately; without options, delegate judgment back to the dog                         |
| Ask chats, guest turns and shared workspaces                                                                   | Keep their existing permission and question rules                                                                                                |

The engine hook, permission request handler and internal computer/browser endpoints use the same owner-Full decision. Internal refusals return an error directly instead of creating a card. Native question answers contain the actual selected label, including structured question keys, so engines that require an exact option can accept the answer. The decision ledger records the automatic answer separately.

Mac lending still requires the correct owner, a connected computer, the actual terminal or computer grant and a current turn. Full does not turn Never into access or revive a denied request. A separate Mac patch supplies that trusted policy bit and retains per-send confirmation.

Own profile, model, routine and skill changes continue using their existing applied receipts and Undo. Genuine missing credentials, external sign-in consent and device-only work are not supplied by Full access.

## Behavior proof

The new owner-Full permission matrix failed first on unchanged main: 22 failures and 7 passes. Additional cases failed first for shell word splitting, an unknown work-tree override, files supplied by another command and unresolved Mac cleanup. All 559 initial focused guard, classifier and settlement checks then passed on the Mac. Review added failing cases for child-shell scope, custom or unreadable field separators, changed temporary directories, assignment-shaped arguments and invalidated working-directory variables. The resolver now isolates child writes, tracks exported values, splits only proven unquoted fields and keeps invalidated values unknown. All 604 final guard, classifier, settlement and isolated end-to-end checks pass, including 52 owner-Full permission cases.

An isolated Cloud-home fixture reproduced a Full question that remained unanswered. After the change it accepts safe cleanup, refuses unknown cleanup and skipped checks, answers multiple questions immediately, exposes no live card for those operations and still waits on sends and payments.

A native engine fixture first rejected a prefixed automatic answer. It then selected the actual recommended option by its protocol ID. The existing timeout behavior outside owner Full stays covered separately.

A fake connected-app broker first demonstrated a protected repository deletion being relayed. The route now checks protected actions before forwarding a Full call and refuses unreadable proxy execution directly.

The source and fixture tests are checked on disposable homes with fake engines and a loopback app broker. No real payment, message send, account consent or production deletion is used as test evidence. The merge pull request must record the complete gate verdict for its exact integrated commit; focused checks alone do not qualify a merge.

## New dogs use the saved owner-wide grant immediately

On a Cloud home with the saved Full-for-all switch enabled, a new owner dog and its first chat start on Full before its greeting, first job or API response. An Ask or Auto creator awaiting idle migration stays unchanged; the independent saved owner grant applies to the new dog. Shared workspaces and guest-driven sources keep their inherited cap. Tool and connector restrictions remain copied, Always keys remain empty, and unsupported engines retain their prior fallback. Body flags cannot enable or disable the persisted setting.

Seven creation regressions failed before the change. Both complete modified creation files pass30checks, and ten related files pass193more, with no skips; the first real fake-CLI child uses bypassPermissions. Full typecheck and lint pass. Existing explicit Full/custom API input remains refused through its separate permission-setting flow. These fixtures do not prove a live provider or UI. A clean combined full merge gate and release are still required.
