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
- a request for `xlarge` is stored as `standard`, the profile ceiling, with one stored `computer_size_clamped` event naming both sizes;
- an unknown size is a 400;
- the same `requestKey` returns the same job and creates no second one;
- a restart keeps those fields, and no provider task id exists;
- the computers listener received no request.

The evidence path is printed first and again at the end. The server and MCP children are stopped in a `finally`
even if writing evidence throws, and SIGINT and SIGTERM stop them too (exit 130 or 143), so a wrapper
timeout leaves no orphans; a child that ignores SIGTERM is sent SIGKILL and awaited. Only the child
handles the wrapper spawned are signalled. The temporary home and data are removed on every path.
`receipt.json` (with the owned child PIDs), `children.json`, the server and MCP logs, the stub call
log and `build.log` are kept, tokens redacted, in the ignored evidence directory
(default `.laterdog-evidence/supervisor-bundle-*`), including after an assertion failure or
interruption; nothing deletes them. `scripts/smoke-laterdog-bundle.test.ts` runs the smoke under vitest
into its own `.laterdog-evidence/` directories, and a second test interrupts the wrapper with SIGTERM
and checks that the recorded server and MCP PIDs are gone and the receipt says `interrupted`.

## Counterfactual

With the previous `build-laterdog.mjs` output in `dist-server/laterdog`, run with
`--skip-build`: the child exits with code 1 and `Dynamic require of "events"` before
any HTTP, and the smoke fails. With the canonical builder it passes.

## Limits

This proves the compiled bundle, not the supervisor image, a native CLI, the computers
service, GitHub or a live provider task. Job preparation reaches the stubbed `gh` and
stops there; no submission is made. Qualify the image and a full Wrangler deploy
separately.
