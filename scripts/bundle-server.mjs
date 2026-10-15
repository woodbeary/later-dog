import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const ENTRY_POINTS = [
  "laterdog/main.ts",
  "laterdog/mcp.ts",
  "laterdog/bridge.ts",
  "index.ts",
  "message-search.worker.ts",
  "laterdog.ts",
  "pair-cli.ts",
  "workspace-backup.worker.ts",
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
  "drivers/dweb-proxy.ts",
  "drivers/phone-proxy.ts",
];

await build({
  entryPoints: ENTRY_POINTS.map((entry) => join(server, entry)),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outbase: server,
  outdir: join(root, "dist-server"),
  allowOverwrite: true,
  logLevel: "info",
  plugins: [yamlEsmPlugin],
});

await build({
  entryPoints: [join(root, "scripts", "mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(root, "dist-server", "mcp-server.js"),
  allowOverwrite: true,
  logLevel: "info",
});

if (existsSync(join(root, "enterprise", "server", "index.ts"))) {
  await build({
    entryPoints: [join(root, "enterprise", "server", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: join(root, "dist-server", "enterprise", "server", "index.js"),
    allowOverwrite: true,
    logLevel: "info",
  });
  copyFileSync(join(root, "enterprise", "LICENSE"), join(root, "dist-server", "enterprise", "LICENSE"));
}

copyFileSync(join(root, "scripts", "desktop-server-entry.mjs"), join(root, "dist-server", "desktop-entry.mjs"));

const catalogSnapshot = join(root, "dist-server", "model-catalog", "models-dev.snapshot.json");
mkdirSync(dirname(catalogSnapshot), { recursive: true });
copyFileSync(join(server, "model-catalog", "models-dev.snapshot.json"), catalogSnapshot);

const piMcpExtSrc = join(server, "drivers", "pi-mcp-extension.ts");
const piMcpExtDest = join(root, "dist-server", "drivers", "pi-mcp-extension.ts");
mkdirSync(dirname(piMcpExtDest), { recursive: true });
await build({ entryPoints: [piMcpExtSrc], outfile: piMcpExtDest, bundle: true,
  platform: "node", target: "node24", format: "esm", external: ["typebox"], });
