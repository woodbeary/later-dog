# Local push checks

Installing dependencies runs `scripts/install-git-hooks.mjs`. It sets the relative
`core.hooksPath` to `scripts/git-hooks`, so linked worktrees use their own checked-out hook.
The hook must be executable. CI does not install local hooks.

The pre-push hook checks changed supported files with Oxfmt 0.80.0, the comment checker
and Oxlint. It always runs the public `pnpm typecheck` command on both complete application
and server graphs, and `pnpm i18n:check`. These checks run concurrently and every failure is
reported. The completed invocation fails if it takes more than nine seconds. The budget
does not terminate running checks; a hung command still needs to be stopped.

The selection is the union of every updated remote-to-local range. A new ref uses the merge
base with `origin/main`; a missing base or object fails the push. Config deletions and renames
remain in the policy selection. Changes to lint configuration or package/lock manifests run
full lint, and changes to the comment checker or its config run the full comment scan.
Deleted ordinary files are not passed to tools that read files.

Formatting covers changed JS/TS, JSON/JSONC/JSON5, CSS/SCSS/Less, HTML/Vue, Markdown/MDX,
YAML, TOML and GraphQL paths supported by the pinned formatter. Its checked-in configuration
excludes generated output, vendored code and lockfiles. It does not reformat the repository
or check unchanged files when formatting policy changes. Review formatting policy changes
with that limit in mind. Comment, lint, type and locale coverage remain independent.

Commit every local change before pushing. Every non-deletion ref must resolve to the checked-out
HEAD commit, including annotated or lightweight tags. Check out another release's commit before
pushing its tag. The hook rejects dirty/untracked files, assume-unchanged or skip-worktree flags,
and tracked symlinks or other unsupported file modes rather than reading hidden or external
contents. It checks the current clean checkout; it does not create an isolated checkout or
protect against another process editing files during the checks.

A valid deletion-only push needs no Node or package dependencies. Malformed or incomplete
records fail before this shortcut. Multi-ref pushes never discard an unsupported update.

Local checks do not qualify a merge. The complete clean `pnpm gate` is still required by
[`AGENTS.md`](../../AGENTS.md). The public gate, typecheck and emitting server build commands
are unchanged by this hook.

Focused checks: `pnpm exec vitest run scripts/git-hooks`. The suite includes actual Git
repositories, annotated tags, hidden index flags, deleted config paths, the real comment
checker, literal formatter paths/configuration, linked worktree installation and collected
child failures. Tests use temporary repositories and do not push to the project remote.
