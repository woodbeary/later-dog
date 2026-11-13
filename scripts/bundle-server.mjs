import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ARCHIVE_CAPABILITY } from "../deploy/laterdog/home/runtime/archive-capability.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");

const yamlEsmPlugin = {
  name: "yaml-esm",
  setup(build) {
    build.onResolve({ filter: /^yaml$/ }, () => ({
      path: join(root, "node_modules", "yaml", "browser", "index.js"),
    }));
  },
};

const nodeEsmBuild = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  allowOverwrite: true,
  logLevel: "info",
  banner: {
    js: 'import { createRequire as __laterdogCreateRequire } from "node:module"; const require = __laterdogCreateRequire(import.meta.url);',
  },
};

const ENTRY_POINTS = [
  "laterdog/main.ts",
  "laterdog/mcp.ts",
  "laterdog/bridge.ts",
  "index.ts",
  "message-search.worker.ts",
  "laterdog.ts",
  "pair-cli.ts",
  "workspace-backup.worker.ts",
  "laterdog/disk-walk.ts",
  "cloud-home-start.ts",
  "server-launcher.ts",
  "proxy-paths.ts",
  "local-computer.ts",
  "local-computer-proxy.ts",
  "hooks/laterdog-hook.ts",
  "container-mcp.ts",
  "vps-container-mcp.ts",
  "permission-proxy.ts",
  "connector-proxy.ts",
  "mcp-gate.ts",
  "mcp-remote-proxy.ts",
  "harness-mcp-proxy.ts",
  "drivers/agents-proxy.ts",
  "laterdog/engine-relay.ts",
  "laterdog/engine-proxy.ts",
];

await build({
  ...nodeEsmBuild,
  entryPoints: ENTRY_POINTS.map((entry) => join(server, entry)),
  outbase: server,
  outdir: join(root, "dist-server"),
  plugins: [yamlEsmPlugin],
});

await build({
  ...nodeEsmBuild,
  entryPoints: [join(root, "scripts", "mcp-server.ts")],
  outfile: join(root, "dist-server", "mcp-server.js"),
});

if (existsSync(join(root, "enterprise", "server", "index.ts"))) {
  await build({
    ...nodeEsmBuild,
    entryPoints: [join(root, "enterprise", "server", "index.ts")],
    outfile: join(root, "dist-server", "enterprise", "server", "index.js"),
  });
  copyFileSync(join(root, "enterprise", "LICENSE"), join(root, "dist-server", "enterprise", "LICENSE"));
}

writeFileSync(join(root, "dist-server", "cloud-home-capabilities.json"), JSON.stringify({ logArchive: ARCHIVE_CAPABILITY,
  launcherSha256: createHash("sha256").update(readFileSync(join(root, "dist-server", "cloud-home-start.js"))).digest("hex"),
  indexSha256: createHash("sha256").update(readFileSync(join(root, "dist-server", "index.js"))).digest("hex") }));

copyFileSync(join(root, "scripts", "desktop-server-entry.mjs"), join(root, "dist-server", "desktop-entry.mjs"));

const catalogSnapshot = join(root, "dist-server", "model-catalog", "models-dev.snapshot.json");
mkdirSync(dirname(catalogSnapshot), { recursive: true });
copyFileSync(join(server, "model-catalog", "models-dev.snapshot.json"), catalogSnapshot);

const piMcpExtSrc = join(server, "drivers", "pi-mcp-extension.ts");
const piMcpExtDest = join(root, "dist-server", "drivers", "pi-mcp-extension.ts");
mkdirSync(dirname(piMcpExtDest), { recursive: true });
await build({ ...nodeEsmBuild, entryPoints: [piMcpExtSrc], outfile: piMcpExtDest,
  target: "node24", external: ["typebox"], });
