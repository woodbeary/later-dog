import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

import { patchAppImageUpdater } from "./patch-appimage-updater.mjs";
import { patchMacUpdater } from "./patch-mac-updater.mjs";
import { patchOrganizationUpdater } from "./patch-organization-updater.mjs";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "electron/vendor/electron-updater.cjs");
const entryPoint = require.resolve("electron-updater");

await build({
  entryPoints: [entryPoint],
  absWorkingDir: entryPoint.split(`${sep}node_modules${sep}`)[0],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  outfile,
  logLevel: "info",
});

await writeFile(outfile, patchOrganizationUpdater(patchMacUpdater(patchAppImageUpdater(await readFile(outfile, "utf8")))));
console.log("patched AppImage replacement, native Mac staging readiness and one-shot organisation relaunch");
