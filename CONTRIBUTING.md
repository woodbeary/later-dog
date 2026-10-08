# Contributing to later.dog

Pull requests are welcome. Read this once; it is short on purpose: most of it is how we prove things.

## What gets merged

- **Evidence, not promises.** A PR says what changed, shows the command and its real output or a screenshot, and names
  what it did not verify. "Fixture success does not qualify a live provider": a passing fixture is a fixture result.
- **One concern per PR.** A feature *and* a refactor will be asked to split. Big changes: open an issue first.
- **Keep native limitations visible.** Backends and engines state what they cannot do (`capabilities.limitation`,
  readiness checks that tell the truth). Never paper over a provider's limit with a hopeful default.
- **Isolated fixtures only.** Server and conversation changes are verified with the isolated launcher in
  [`docs/verification/README.md`](docs/verification/README.md), never against the person's live `~/.laterdog`.
- **Small modules over big files.** New behaviour goes in its own file (for example under `server/laterdog/`) with its
  own tests, rather than growing `server/index.ts`.
- **Match the altitude.** Plain Node, no frameworks on the server, one store, one event bus. A new runtime dependency
  needs a reason in the PR.

Review and merge are a person's job (the maintainer, or a reviewer they name). A bot may open a draft PR; a bot never
merges. If your change is cool and proven it will be merged; if it is proven but out of direction, the review says why.

## Dev setup

Node 24+, pnpm 10.33, and for chatting with a dog at least one provider CLI signed in
(`codex`, `claude` or `grok`).

```sh
git clone https://github.com/woodbeary/later-dog.git && cd later-dog
pnpm install --frozen-lockfile
pnpm laterdog:dev        # app at http://127.0.0.1:5299 (browser page of the same app)
pnpm laterdog:package    # unsigned local Mac app → release/mac-arm64/later.dog.app
pnpm lint && pnpm typecheck && pnpm laterdog:test && pnpm build   # what CI runs
pnpm laterdog:skills     # re-export canonical skills (edit skills/laterdog/, never the exports)
```

Everything the project knows about itself is indexed in [`llms.txt`](llms.txt); the rules every agent follows are in
[`AGENTS.md`](AGENTS.md); verification fixtures and the live acceptance steps are in
[`docs/laterdog/verification.md`](docs/laterdog/verification.md).

## Repo map

| Path | What lives there |
|---|---|
| `server/laterdog/` | The supervisor (SQLite jobs, publishing, verification, review, repair), its HTTP API and MCP tools |
| `deploy/laterdog/` | Supervisor container, entrypoint, Cloudflare Worker |
| `skills/laterdog/` | Canonical skills exported to Codex, Cursor and Claude Code |
| `docs/laterdog/` | Deployment, Cloudflare, verification, playbook, roadmap, audit and acceptance records |
| `server/contracts.ts` | The engine driver contract and canonical runtime events — read it first |
| `server/drivers/` | One file per provider; adding one = one file + one registration line in `builtIn.ts` |
| `server/index.ts` | The HTTP + SSE API the app talks to (being split into modules; add new routes under `server/routes/`) |
| `src/` | The React app; `src/locales/en.json` is the copy's source of truth |
| `electron/` | Desktop shell: dictation, screen capture, local computer control; macOS-specific code gated |

## Tests

Colocated (`**/*.test.ts`), run with `pnpm exec vitest run <files>`; `pnpm laterdog:test` runs the supervisor's
fixtures. House rules: no sleeps (wait on the event that proves the behaviour); never touch the real data directory;
fake CLIs under `server/testing/` are launched through `spawnCli`, extended by env var modes rather than mocking
`child_process`. Provider changes keep the contract tests green; new server behaviour brings a test.

## Copy and locales

User-visible text lives in `src/locales/en.json` and is read with `t("…")`. later.dog's pets are dogs and the UI says
so (dogs, tricks, fetch, heel/off-leash, packs) with the plain meaning beside each term; model-facing prompts stay
plain. When you rewrite an English string, delete the stale translations so they fall back, run
`node scripts/generate-locale.mjs <lang> --accept` for the packs you touched, and `pnpm i18n:check` must pass.

## House rules

- **MCP tool schemas stay flat**: no `oneOf`/`anyOf`/`allOf`/`const`/`format`; coerce before you reject; errors teach.
- **Never build command strings for a shell**; argv only. POSIX-only calls need a gated Windows equivalent.
- **Secrets are write-only**: they land in the data directory's `config.json` and the API reports only `configured`
  booleans. No logging keys, no echoing them in events, nothing a bot could read back.
- **Platform code stays gated**: the harness (`server/`) is portable Node; anything macOS-only lives in `electron/`.

## Licensing

Apache-2.0; by opening a PR you agree your contribution is licensed the same way. No DCO or CLA.

## Before you open the PR

- [ ] `pnpm lint && pnpm typecheck` pass; the tests for what you touched pass; `pnpm i18n:check` if you touched copy
- [ ] Server or conversation change: verified with an isolated fixture, output in the PR
- [ ] Anything a person sees: a screenshot from the built-in browser or the app
- [ ] Limits stated; no claim the PR did not prove
