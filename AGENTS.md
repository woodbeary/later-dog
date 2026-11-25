# later.dog agent notes

Use the exact Bun 1.4.5 package manager declared in package.json. Node 24+ remains required.
Install the root with `bun install --frozen-lockfile --cpu=arm64 --cpu=x64`; standalone packages use
`bun install --cwd <folder> --frozen-lockfile`. Every package uses isolated linkage and explicit
trustedDependencies. Keep external projects and registry publishing on the tools they require.
Keep native backend limitations visible; fixture success does not qualify a live provider.

The installed pre-push hook checks changed-file format, comments and lint together with full
application/server types and locale validation. It requires a clean HEAD checkout with no hidden
index flags or tracked symlinks, handles HEAD release tags, and requires completed checks below nine
seconds. See [`docs/laterdog/pre-push.md`](docs/laterdog/pre-push.md) for selection and limits.
Run `bun run vitest run scripts/git-hooks` after changing the hook. Local success never replaces
the complete clean merge gate below.

Use `cf` for Cloudflare account and zone work (DNS, rules, zone settings, gateways) and
Wrangler for container Workers. Change a container Worker only with a full `wrangler deploy`,
never by patching its settings through the API.

No comments in code. Say it with names, types and tests; only lines tools read
(lint and test directives) and the licence notices adapted code came with stay.
`scripts/no-comments.test.ts` fails on any other; `node scripts/no-comments.ts --write`
removes them.

Describe later.dog on its own terms. Name another product only where later.dog works
with it (an engine it runs, an app that connects to it), never as a model to follow or a
comparison, and never cite studies, captures or reference material. That holds for code,
tests, docs, commit messages and pull requests. `scripts/brand-links.test.ts` keeps known
names out; the attribution the licence requires stays in NOTICE.

Work in progress, its gates, and how to resume any lane: [`docs/laterdog/finish-line.md`](docs/laterdog/finish-line.md). Read it before starting.

Nothing merges to `main` until a complete `bun run gate` run (`scripts/merge-gate.mjs`) on a
clean checkout of the branch, with `origin/main` fetched and merged in, ends with the line
`VERDICT: PASS` and nothing after `PASS` but the commits, and exits 0. The gate runs typecheck,
lint, the desktop node tests, the broker tests, the
packaged-server check, the vitest suite in eight parts, and the tests in `deploy/laterdog/home`,
`cloudflare/control-plane` and `deploy/laterdog/computers`. A run with `LATERDOG_GATE_OFFLINE=1`,
`LATERDOG_GATE_NO_BROWSER=1` or a non-empty `LATERDOG_GATE_UNAVAILABLE` ends with
`VERDICT: PASS WITH GAPS` and names each gap; it qualifies only together with a second run, on a
machine without those gaps, that covers each named gap, and the pull request names both runs. A
`--only` run is `PARTIAL` and never qualifies. Focused tests alone never qualify a merge.

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

The later.dog Dev app ([`docs/laterdog/dev-app.md`](docs/laterdog/dev-app.md)) runs this
checkout, and its dogs may be editing the app they are running in. A file saved under `src/`
changes the person's window within a second, so keep every save working and commit working
steps. `server/` and `electron/` changes wait for later.dog Dev → Restart later.dog Dev; ask
the person to choose it rather than quitting or restarting the app yourself, which ends your turn.

More specific `AGENTS.md` files override this note within their directories.
