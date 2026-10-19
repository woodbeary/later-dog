import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, "../../docs/assets/readme");

const scenes = {
  hero: ["--scale", "0.5", "--tick", "80", "--quality", "60"],
  phone: ["--scale", "0.75", "--trim-end-ms", "600"],
  computer: ["--trim-end-ms", "440"],
  schedule: ["--trim-end-ms", "440", "--first-ms", "900"],
  helpers: ["--trim-end-ms", "400", "--first-ms", "500"],
};

const [siteDir, framesDir, ...only] = process.argv.slice(2);
if (!siteDir || !framesDir) {
  process.stderr.write("usage: node scripts/readme-media/render.mjs <built site dir> <frames dir> [scene ...]\n");
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const [scene, options] of Object.entries(scenes)) {
  if (only.length && !only.includes(scene)) continue;
  for (const variant of ["light", "dark"]) {
    run(process.execPath, [join(here, "record.mjs"), resolve(siteDir), scene, variant, resolve(framesDir)]);
    run("python3", [join(here, "encode.py"), join(resolve(framesDir), `${scene}-${variant}`), join(assets, `${scene}-${variant}.webp`), ...options]);
  }
}
