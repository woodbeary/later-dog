import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DurationSequencer } from "./scripts/testing/duration-sequencer.ts";
import { createRequire } from "node:module";

const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

const { SCRIPT_DEFAULTS, scriptTarget } = createRequire(import.meta.url)("./electron/app-variant.cjs") as typeof import("./electron/app-variant.mjs");
const devTarget = scriptTarget();
const proxyPort = devTarget.refusal ? SCRIPT_DEFAULTS.serverPort : devTarget.serverPort ?? (devTarget.live ? 8799 : SCRIPT_DEFAULTS.serverPort);
const apiTarget = process.env.LATERDOG_DEV_API_URL || `http://127.0.0.1:${proxyPort}`;

const refuseLiveDevServer = (): Plugin => ({
  name: "laterdog-refuse-live-dev-server",
  config(_config, { command }) {
    if (command === "serve" && devTarget.refusal && !process.env.VITEST) throw new Error(devTarget.refusal);
  },
});

export default defineConfig({
    plugins: [refuseLiveDevServer(), react(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    test: {
      environment: "node",
      include: [
        "evals/**/*.test.ts",
        "server/**/*.test.ts",
        "electron/**/*.test.mjs",
        "src/**/*.test.ts",
        "shared/**/*.test.ts",
        "scripts/**/*.test.mjs",
        "scripts/**/*.test.ts",
      ],
      setupFiles: ["server/testing/setup.ts"],
      fileParallelism: false,
      sequence: { sequencer: DurationSequencer },
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: Number(process.env.LATERDOG_UI_PORT) || 5199,
      watch: {
        ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
      },
      proxy: {
        "/api": {
          ws: true,
          target: apiTarget,
        },
        "/.well-known/laterdog/environment": {
          target: apiTarget,
        },
      },
    },
});
