import { build } from "esbuild";
await build({ entryPoints: ["server/laterdog/main.ts","server/laterdog/mcp.ts","server/laterdog/bridge.ts"], outdir: "dist-server/laterdog", bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "info" });
