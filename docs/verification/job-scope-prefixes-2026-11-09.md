# Job write scopes: trailing `/**` as a directory prefix

Initial authoring snapshot (superseded by the qualification below). Source head: `fcfbc41d06e385641b56ea65b1090fcde70bfe0f` plus the uncommitted diff to
`shared/laterdog.ts` and `shared/laterdog.test.ts`. Not deployed, not released, and no live
job was inspected or changed.

## Production qualification, November 9

PR144 and PR145 are merged. The final source is
`f3320ad3a4c39219703d93e778853be94920a44b`; independent Claude review on a
separate cloud computer passed 83 focused tests and reproduced all eight
literal-route failures before the repair. Its additional literal boundary and
MCP schema probes passed. The canonical `pnpm laterdog:build` exited zero.

Five canonical bundles replace `/app/laterdog` as one opaque Linux image layer
over the exact previous production image. This is not a full Dockerfile rebuild.
The final image is
`registry.cloudflare.com/da1336ec3e3f7d9a4971022ae074c5d7/laterdog-supervisor-scope@sha256:3615411a0a2e68b39af78b52ab2aba616d45473a43b664a9d97679c03bdb3f9c`.
The archive fixes uid/gid to zero, directories to 0755 and files to 0644; compiled
source hashes are unchanged. An earlier isolated candidate used a private
0700 staging-directory mode and could not start as the runtime user. It was
rejected before production and is not the released image.

Dedicated native staging Worker `f23da358-faf4-4231-b35e-11765db9db88` passed:
wrong-token refusal; actual Linux startup; trailing directory and literal
bracket/brace/exclamation scopes; duplicate-safe creation; five malformed scope
refusals; and graceful restart retaining three exact synthetic job IDs. Jobs
were held behind a cancelled synthetic dependency. No owner database, provider
credentials or provider tasks were used. `providerQualified` remains false.

A read-only fresh R2 backup passed SQLite quick_check and retained all 81
production job IDs and two profiles before deployment. Full `wrangler deploy`
activated production Worker `9f3ff9b0-b6ce-4acd-a69d-e0bd5b7433e3` on the final
image. All ten binding definitions, including five secret names and both exact
plain-text values, match the pre-deployment settings; compatibility and
observability settings match. The owner's home was not restarted. The bounded
post-rollout retention and health window passed 21 consecutive qualified samples
from 23:58:35.138 UTC November 9 to 00:08:59.557 UTC November 10. All 81 jobs,
two profiles, 80 dogs and their tasks were retained; the home remained PID24 and
the four WoW dogs remained idle. All 21 samples reported low space, so this
release does not qualify a larger fleet or remove provider quotas.

Private receipts are under `.laterdog-evidence/scope-release/`: canonical build
exit/log, Linux layer provenance, native staging qualification, pre-promotion
backup, full deploy log, binding comparison and production monitor. Encrypted
sign-in backups were never decrypted. Failed-job checkpoint PR147 subsequently
superseded this supervisor image through source `0609ec0b` and image `9de367a3`;
its separate completed native rollout is recorded in
[failed-source checkpoint qualification](failed-cloud-checkpoint-2026-11-09.md).
The computer-workspace prototype PR146 remains default-off and unactivated.

## Defect

`scopesOverlap(["server/laterdog/**"], ["server/laterdog/janitor.ts"])` and
`pathInScopes("server/laterdog/engine-files.ts", ["server/laterdog/**"])` were both `false`:
the schema accepted `dir/**` but the predicates compared it as a literal prefix.

## Change (`shared/laterdog.ts`)

- `canonicalScope` turns trailing `/**` (repeated) into its directory and `**` into `*`.
- `scopesOverlap` and `pathInScopes` canonicalize every scope first, so scopes already stored
  as `dir/**` are read as `dir` for both publish permission checks and concurrency checks.
- `scopePath` validates the canonical form and now refuses embedded glob syntax
  (`*` and `?` anywhere but a trailing `/**`), as well as the existing traversal, `.git`,
  absolute, backslash and empty-segment refusals. `*` and exact files stay valid.
- Directory boundary is unchanged: `server/foo` does not match `server/foobar`.

## Checks

- Before the fix (source change stashed, new test kept):
  `pnpm vitest run shared/laterdog.test.ts` gave 5 failed, 2 passed.
- After: `pnpm vitest run shared/laterdog.test.ts scripts/no-comments.test.ts scripts/brand-links.test.ts`
  gave 3 files, 20 tests passed.
- `pnpm vitest run server/laterdog` gave 210 files passed, 1 failed. The failure is
  `server/laterdog/removed-dog-settings.test.ts` (file-not-writable case), which also fails with this change
  stashed. `server/laterdog/cloud-account-sign-in.test.ts` failed once under load and passed on its own rerun
  with the change stashed.
- `npx tsc --noEmit -p .` printed no errors.

## Remaining limits

- Scopes are not rewritten in storage. Stored `dir/**` scopes stay as written and are read
  as `dir`; the prompt text and PR body still print them as stored.
- Canonicalizing new requests when a job is created would need a change in
  `server/laterdog/supervisor.ts`, outside this job's write scopes. A zod transform on
  `scopePath` was tried and reverted: it breaks `z.toJSONSchema` for the MCP tool schema
  (`server/laterdog/http.test.ts`, `server/laterdog/job-trace-http.test.ts` failed with "Transforms cannot be represented").
- Scopes such as `dir/*` or `a/**/b` are now refused for new requests; already-stored ones are
  treated as literal paths.
- Not deployed; no claim about live jobs, including job 29b2ff1d.

## Literal route compatibility repair

Base: `49c1f18bb744848f66f2a4dc11c7fcd19413462f` (PR 144). Branch:
`clover/literal-route-scopes-20261109`. This follow-up changes only this record and
`shared/laterdog.ts` / `shared/laterdog.test.ts`.

The previous validator incorrectly rejected literal `[]{}!` characters. Actual
route paths `src/app/[handle]/page.tsx`,
`src/app/api/notifications/[id]/route.ts`, and
`src/app/api/operator/refunds/[id]/route.ts` matched literal scope predicates but
could not pass job creation validation. The validator now permits these characters
without adding glob interpretation, a parser, a dependency, a filesystem lookup,
or a schema transform.

Eight acceptance cases cover those routes, `[...slug]`, `[[...slug]]/**`, braces,
exclamation marks and combined punctuation. Separate matching checks retain exact
and directory-prefix boundaries in both overlap directions, excluding `app/123`,
other bracket names, expanded brace alternatives and sibling names. Unsupported
embedded `*` and `?`, traversal, `.git`, absolute paths, backslashes and empty
segments remain rejected. Root `*`, the intentional `**` alias and repeated terminal
`/**` normalization remain covered by existing checks.

Verification ran on Clover's own cloud computer in
`/home/dog/literal-route-scopes-20261109`, with Node `v24.22.0` and pnpm `10.33.0`:

- Before the source change, the updated shared tests gave **8 failed, 15 passed**.
  All eight failures were literal-scope validation cases. Log:
  `/tmp/clover-literal-before.log`.
- After the one-line validator change, this exact focused command passed **7 files,
  83 tests**: `corepack pnpm exec vitest run shared/laterdog.test.ts
  server/laterdog/supervisor.test.ts server/laterdog/github.test.ts
  server/laterdog/http.test.ts server/laterdog/job-trace-http.test.ts
  scripts/no-comments.test.ts scripts/brand-links.test.ts`.
  Log: `/tmp/clover-literal-focused.log`.
- Direct `z.toJSONSchema(createJobSchema)` and actual `mcpTools` serialization passed
  for supervisor (15 tools) and dog (3 tools) contexts. Log:
  `/tmp/clover-literal-mcp-schema.log`.

These are isolated fixtures and pure schema checks; no owner data, live dogs,
customer operations or provider tasks were mutated. No full server suite or build
was run for this repair. Canonical build, independent review and production
activation remain outside this branch. No deployment, merge or restart occurred.
