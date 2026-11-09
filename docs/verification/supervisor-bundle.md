# Compiled supervisor bundle

The supervisor image copies only `dist-server/laterdog`. `pnpm laterdog:build` now runs
`pnpm build:server`, so `scripts/bundle-server.mjs` is the one place that names the
entry points, the `createRequire` banner and the YAML plugin. A separate supervisor
builder once omitted the banner, and its `main.js` exited before listening with
`Dynamic require of "events" is not supported`.

Extra work against the old two-line builder: `tsc -p tsconfig.server.build.json`
and every other server entry now build too. The image
still copies only `dist-server/laterdog`, and the Dockerfile, `pnpm laterdog:build`
and the runtime choices are unchanged.

## Run

```sh
pnpm smoke:laterdog-bundle
node scripts/smoke-laterdog-bundle.mjs --skip-build --evidence DIR
```

It runs `pnpm laterdog:build`, then starts the compiled `main.js` in a fresh temporary
data directory and home, with synthetic tokens, stubbed `git`, `gh`, `codex` and
`claude` that fail closed, a clean child environment, and a loopback computers URL
whose listener counts requests. It uses a `laterdog-cloud` profile capped at
`standard` and an unconnected fixture repository. It then checks, over HTTP and
through the compiled `mcp.js`:

- authenticated HTTP is reached and a wrong token is refused;
- `delegate_cloud_job` inherits the dog's model, account and effort;
- a request for `xlarge` is stored as `standard`, the profile ceiling, with a clamp event;
- an unknown size is a 400;
- the same `requestKey` returns the same job and creates no second one;
- a restart keeps those fields, and no provider task id exists;
- the computers listener received no request.

Children are stopped and the temporary data removed on every path. `receipt.json`,
the server and MCP logs, the stub call log and `build.log` are kept in the evidence
directory (default `.laterdog-evidence/supervisor-bundle-*`) with the synthetic tokens
redacted. `scripts/smoke-laterdog-bundle.test.ts` runs the same smoke under vitest.

## Counterfactual

With the previous `build-laterdog.mjs` output in `dist-server/laterdog`, run with
`--skip-build`: the child exits with code 1 and `Dynamic require of "events"` before
any HTTP, and the smoke fails. With the canonical builder it passes.

## Limits

This proves the compiled bundle, not the supervisor image, a native CLI, the computers
service, GitHub or a live provider task. Job preparation reaches the stubbed `gh` and
stops there; no submission is made. Qualify the image and a full Wrangler deploy
separately.
