import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pin = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "")?.[1];
const agent = process.env.npm_config_user_agent?.split(/\s+/)[0];
const binary = process.env.npm_execpath;

try {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Node 24 or newer is required");
  if (!pin || agent !== `bun/${pin}` || !binary)
    throw new Error("the declared installer is required");
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (result.error || result.signal || result.status !== 0 || result.stdout?.trim() !== pin) {
    throw new Error(
      result.error?.message ?? result.signal ?? "the installer version does not match",
    );
  }
} catch (error) {
  console.error(`Use Bun ${pin ?? "1.4.5"} to install this package: ${error.message}`);
  process.exitCode = 1;
}
