# Item 21: remove desktop and server code nothing uses

Read `/Volumes/fable-native/briefs/wave2/LEAD.md` first: it says how you work. Lane name `lean`, branch `fable/lean-code`. This lane goes last: start it only after every other branch of the night has merged, then base it on the newest `main`.

## What the person sees today and should see instead
Nothing visible changes. The repository carries lines nobody reaches, which every later change has to read around.

## Where it lives
A survey exists: `/Volumes/fable-native/tmp/t/lean/SURVEY.md` (112 lines), with `desktop-candidates.tsv` (248 rows: path, kind, lines, evidence, confidence), `desktop-dead-notest.tsv`, `desktop-dead-withtests.tsv`, `desktop-exports.tsv`, and the scripts `graph.mjs` and `exports.mjs`. It estimates about 1,350 to 2,050 removable desktop and server lines. The survey is from 13 November, on an older commit: re-run the two scripts (read-only) against the current `main` before trusting a row.

The repository follows an upstream project. "Root" in the survey's evidence means the file already existed in the squashed fork base (commit 082fce401), so it may be upstream's. Remove only what later.dog added and nothing reaches.

## What to build
In separate commits, one kind per commit (files nothing imports; whole functions with zero references; exports used only by their own tests, removing the tests too; unused style keys; unused scripts and assets), each with a typecheck, lint and the touched tests passing, and the two house-rule tests (`scripts/no-comments.test.ts`, `scripts/brand-links.test.ts`). Skip anything you cannot show is unreached by dynamic use (a route name built from a string, a script named in a package file, a file read by the release script, a locale key).

## Done means
Each commit says in plain words what was removed and why it was unreachable (the evidence); a reviewer who did not write it re-checks ten sampled rows from your list and finds none reachable; the whole gate (`pnpm gate`, run by the maintainer) passes on the result; the release file check does not flag a removed file the release needs.

## Out of scope
Anything upstream may own without evidence it is later.dog's, the phone repository (it has its own survey rows), behaviour changes, renames.

## What only a real home or phone can prove
That a packaged desktop app still starts and a home still boots with the code gone: the maintainer's whole-gate run plus one fixture home start covers it; a real desktop launch is the only full proof.
