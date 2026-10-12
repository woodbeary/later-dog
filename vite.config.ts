import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DurationSequencer } from "./scripts/testing/duration-sequencer.ts";

const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      "companion/**/*.test.ts",
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
        target: `http://127.0.0.1:${process.env.LATERDOG_SERVER_PORT || 8799}`,
      },
      "/.well-known/laterdog/environment": {
        target: `http://127.0.0.1:${process.env.LATERDOG_SERVER_PORT || 8799}`,
      },
    },
  },
});
