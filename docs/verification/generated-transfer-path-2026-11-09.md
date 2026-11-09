# Generated transfer exclusions and remote package PATH

Branch: `clover/generated-transfer-path-20261109`.
Base: `aedb058d` (the literal-route repair is already merged).
Worktree: `/home/dog/generated-transfer-path-20261109` on Clover's cloud computer.
Node 24.22.0 and pnpm 10.33.0. Isolated fixtures only.

## Repair

`.open-next` moves into the existing exported `BUILD_OUTPUT_DIRS` fact in
`janitor.ts`; the separate `GENERATED_DIRS` fact is removed. That same module
exports `isGeneratedPath`, recognizing those directory segments and the exact
adjacent `.wrangler/tmp` segments at any nesting depth. No new helper, duplicate
policy, workspace state or cache is introduced.

Computer-run stamping, send/removal delta selection, returned-file selection and
engine inventory use that predicate. Engine walking prunes generated paths;
explicit `root.files` entries also apply the rule after existing path validation.
The remote result walker uses the exported directory facts for simple pruning;
returned path listings are filtered by the canonical predicate before packing or
copying any file payload. Nested scratch paths therefore never come home.

Legacy before-stamps are filtered before calculating removals. A newly excluded
build file is neither resent nor remotely deleted. Persisted returned stamps also
remove excluded entries. Actual removed source still propagates to the computer.
No pre-existing home files are removed by this repair.

`.wrangler/state` and `.wrangler/cache`, source, results and Git files retain their
existing transfer behavior. Transport-only `dist`, `build`, `out`, coverage and
report exclusions remain separate from the janitor's deletable directories.
Existing outbound treatment of those transport-only names is unchanged. Malformed
absolute/traversal/backslash/control/empty-segment listing or stamp paths are
excluded before packing or removal; invalid or negative returned sizes are refused.
Transfer budgets and existing fallback decisions are unchanged.

Remote Claude PATH keeps its exact versioned engine CLI bin first, then adds the
computer's `/home/dog/.local/bin` and `/home/dog/.npm-global/bin`, followed by the
existing `/usr/local/bin:/usr/bin:/bin`. The home PATH is never appended. Existing
configuration, scoped account and hook boundaries are reused; no credentials are
added to PATH or logs. No driver, warm-engine or remote-engine owner files change.

## Evidence

Five new regressions failed on unchanged source, then passed after the source fix:
`/tmp/clover-transfer-before.log` and `/tmp/clover-transfer-after.log`.

- The actual local-box run creates 252 `.open-next` files plus nested
  `.wrangler/tmp` output. Before, all 252 generated paths appeared in returned files.
  After, none are transferred home; source/results/state/cache/Git changes return.
  A pre-existing home generated file stays intact; generated payload stays remote.
- A saved legacy stamp no longer causes remote deletion of excluded generated files,
  while a real removed source file is deleted remotely.
- Stamps and returned selections agree on nested generated versus retained paths.
- Walking and explicit engine selections exclude generated paths, preserve retained
  files and retain traversal refusal.
- PATH checks assert exact precedence for hostile, unrelated and empty home PATHs.

The first focused run had 62 passes and one existing timed-run failure. Its fake
computer was performing a real package-manager bootstrap before a two-second
command, racing its fixed 2.5-second wait. The local-box fixture now supplies an
inert pnpm executable, removing that unintended network dependency. All 14
computer-run tests then passed (`/tmp/clover-transfer-runs-final.log`). Production
bootstrap behavior is unchanged.

Server TypeScript passed (`/tmp/clover-transfer-types.log`); targeted lint over the
seven changed TypeScript files passed with zero errors and warnings
(`/tmp/clover-transfer-lint.log`). No full server sweep or canonical build was run.
No live home, TASK workspace, customer/provider operation, deployment, restart,
physical Mac, WoW, archive or retention policy was changed. Live activation and
independent review remain with Root and Patch after their safe checkpoint.

Final command: `corepack pnpm exec vitest run server/laterdog/janitor.test.ts
server/laterdog/computer-runs.test.ts server/laterdog/computer-run-route.test.ts
server/laterdog/engine-files.test.ts server/laterdog/engine-placement.test.ts
scripts/no-comments.test.ts scripts/brand-links.test.ts`.
All 63 tests in seven files passed (`/tmp/clover-transfer-focused-final.log`).
Server TypeScript passed again on the final source
(`/tmp/clover-transfer-types-final.log`). No live capacity savings are claimed.
