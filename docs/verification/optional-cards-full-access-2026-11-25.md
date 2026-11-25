# Optional cards in an owner's Full access conversation

25 November 2026. This change covers the routine-away pause card and the watcher's passive
`create_options_card` tool. The policy is derived by the server from both owner authority and the
effective approval mode of the actual source conversation. A dog's saved Full default is not enough.

## Behaviour

- A completed routine in an owner's Full access conversation leaves enabled routines running. It
  does not count toward the away/unread pause threshold and creates no pause card. Disabled routines
  stay disabled. No permanent keep-running preference is saved, so an Ask source retains its policy.
- The watcher receives a 403 tool error for a generic options card in that owner's Full access
  source. No message is appended. The dog is told to decide routine choices itself and continue.
- Card input cannot set or clear the trusted policy flag. The same dog's Ask task still accepts a
  valid card; malformed cards, other dogs and stale capabilities keep their existing refusals.
- Payment and send approvals, account access, credentials, secure forms and takeover flows are
  outside this change.

The only `server/index.ts` edits provide the trusted policy to `RoutinePauses`, pass the completed
routine's source thread into its result handler, and provide the policy at the watcher card route.
Existing source ownership and active-capability checks still run before the route creates anything.

## Before the fix

Against main `4efafe4ce938f485e23bdbd531c184f246249c5c`, the new tests ran with production files
unchanged: **4 failed, 14 passed**. The real HTTP fixture received 201 and a persisted card where
Full required 403. Routine checks showed enabled routines being disabled after the unread threshold.
Cloud check run: `9f902e40`.

## After the fix

The six production/test files on the checking computer matched the Mac checkout byte for byte.
Cloud check run `0e53f0dd` exited 0:

- 87 tests passed across 9 files, including the isolated real HTTP fixture, routine persistence and
  narrowed access, the watcher tool/schema, source approval mode, owner authority, brand and comments.
- `pnpm lint`, full `pnpm typecheck`, `pnpm i18n:check` and `git diff --check` passed.

```sh
pnpm exec vitest run server/laterdog/routine-pause.test.ts server/options-card.test.ts server/optional-cards.e2e.test.ts shared/options-card.test.ts server/drivers/agents-options-card.test.ts server/approval-mode.test.ts server/laterdog/owner-auto.test.ts scripts/brand-links.test.ts scripts/no-comments.test.ts
pnpm lint
pnpm typecheck
pnpm i18n:check
git diff --check
```

The HTTP fixture uses `launchVerificationServer`, fake engines and temporary data. It checks Full
refusal without a card, forged input flags, an Ask task on the same Full-default dog, and a stale turn.
It does not contact the owner's live app or accounts. The simulated long routine history runs on a
controlled clock in the routine tests.

## Release limits

This is not live. The complete merge gate has not run for this patch. The primary lane must integrate
it with the rest of the approval work, merge current main, and obtain `VERDICT: PASS` before Sol Lead
merges or publishes. Existing disabled routines and past cards are not migrated. Real device and
production notification behaviour were not exercised; no UI rendering changed.
