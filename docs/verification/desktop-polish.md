# Desktop progress and teammate rename follow-up

This follow-up starts from the released 0.3.29 sources. It preserves the
one-question-at-a-time dialog and quiet exchange lines already shipped there.

## Behavior

- See progress uses compact connected steps, with separate running, completed,
  failed and stopped indicators. Updates and streamed progress summaries start
  collapsed. Keyboard focus, Escape, outside dismissal, responsive scrolling,
  and measured placement remain available.
- One successful opened-thread receipt shows its title and bot directly.
  Consecutive successful receipts become a compact disclosure.
  Every original destination stays available with its current title and bot
  name. Boundaries preserve intervening visible messages, separate turns and
  days. Search expands before focus runs, and room replies retain their author.
- Any bot can propose a reachable teammate's name through
  `propose_profile(for_bot_id, name, reason)`. An ordinary bot's proposal waits
  for your confirmation, even under Full Access. Other profile fields retain
  their existing role and team restrictions. Confirmation checks reachability,
  visibility and the profile revision again.
- Pinned authors, sidebar authors, generated work-thread titles and opener/closer
  labels resolve stable bot IDs. Stored text and custom titles stay intact.
  Ambiguous old mentions stay plain rather than identifying a different bot.
  Legacy textual aliases retain the existing six-name history limit.

## Verification

`server/profile-peer-rename.e2e.test.ts` launches an isolated server and fake
engine. It exercises ordinary peer proposals, confirmation, forbidden extra
fields, revoked access, stale changes and saved history through HTTP routes.
The fixture uses temporary data and does not touch the running app.

Focused DOM and unit regressions cover the progress drawer and narration
controls, opened-thread grouping and navigation, pinned/sidebar identity,
generated titles, aliases, catalog exposure and the existing question flow.
Renderer and server TypeScript, lint, locale validation, focused unit/DOM/API
regressions and the no-comments check pass on Node 24. Production renderer build
passes with the existing CSS Highlight and large-chunk warnings.

Commands use pnpm. The Vite build uses `pnpm exec vite build --configLoader runner`
and Vitest uses `pnpm exec vitest run --cache=false --configLoader runner` so
shared dependency folders do not need writable caches. The scoped suites cover
all changed components and policies, plus the question-card flow and verification
documentation. No live data or running app state was changed.

## Release candidate integration, 2026-10-14

PR #60 at `c8cfa1f9b3b933f9bc3a2c26a19a5a6197b19c64` was integrated
with PR #57 at `5177c3a7470cc753ef930680954192ad7b6a3b52`. The only
conflict was the catalog profile manifest. Regenerating it from the combined
implementation preserves Cloud shared-computer fields and reviewed peer rename
targeting; all 67 catalog checks then passed without update mode.

On Node 24.6.0, the combined source passed 563 tests across 24 scoped suites,
including the fake-engine HTTP profile fixture, question cards, updater,
catalog, room/search, identity and verification-document regressions. The first
sandboxed proxy test could not bind loopback; its 158 tests passed when rerun
with the isolated HTTP fixture outside the sandbox. Both TypeScript projects,
whole-repository lint, locale validation and the production renderer build
passed. Existing CSS Highlight and chunk-size build warnings remain.

An independent source review found no integration regression in the overlapping
Cloud, catalog, profile-policy or renamed-reference behavior. Full CI for the
combined candidate remains a separate gate. This records source integration;
no main merge, release, installation or live-provider check was performed.

## Limits

Needs visual verification. This conversation's computer selection is Off and
cannot be changed through the mounted tools. DOM tests and fake-engine HTTP
fixtures do not establish installed-app appearance or live-provider behavior.
No release or installation is implied by this source change.
