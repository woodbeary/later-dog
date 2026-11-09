# Idle generated build output: .open-next and .wrangler/tmp (2026-11-09)

A production low-disk inventory found idle projects holding `.open-next` build outputs and `.wrangler/tmp` scratch that neither the janitor nor the space maker cleared, because `findBuildOutput()` did not list them.

## Change

- `server/laterdog/janitor.ts`: `findBuildOutput()` now returns any `.open-next` directory, and the `tmp` directory directly inside a `.wrangler` directory. It never descends into `.wrangler` otherwise, so `.wrangler/state` and `.wrangler/cache` are never listed. Symlinks are skipped as before. `buildOutputProject()` names the project a build directory belongs to.
- `server/laterdog/space-maker.ts`: `inUse()` takes the project from `buildOutputProject()`, so for `.wrangler/tmp` the project is the repo root, not `.wrangler`. A process whose cwd is in the repo, or whose argv names it, or a busy directory, protects the scratch.
- Workspace eligibility and retention are unchanged; `node_modules` behaviour is unchanged.

## Tests

- `server/laterdog/janitor.test.ts`: `.open-next` and `.wrangler/tmp` (also nested under `src`) are found and removed from an idle workspace. `.wrangler/state`, `.wrangler/cache`, a plain `tmp`, media, `package.json`, a symlinked `.open-next` and a symlinked `.wrangler/tmp` (both pointing outside) are kept, and the symlink targets are untouched.
- `server/laterdog/space-maker.test.ts`: an idle project loses `.open-next` and `.wrangler/tmp` only. Projects with a process cwd at the repo root, a process argv naming the project, or a busy directory keep both. `inUse` and `buildOutputProject` are checked directly.

## Commands and results

- Before the fix (recognition absent), `pnpm vitest run server/laterdog/janitor.test.ts server/laterdog/space-maker.test.ts`: 2 failed, 10 passed. The janitor test failed on the `findBuildOutput` list, and the space-maker test got `[]` where `idle/.open-next` and `idle/.wrangler/tmp` were expected.
- After the fix, `pnpm vitest run server/laterdog/janitor.test.ts server/laterdog/space-maker.test.ts scripts/no-comments.test.ts scripts/brand-links.test.ts`: 4 files, 25 tests passed.
- `pnpm exec oxlint` on the four changed source and test files: no findings.

## Limits

All runs used temporary directories. No live cleanup was run from this job, and the earlier operational prune was not repeated. The full test suite was not run.
