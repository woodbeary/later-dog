import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { getPlatformProxy } from "wrangler";
import {
  materializeHome,
  stageManifest,
  publishManifest,
} from "./home-manifest.mjs";

process.umask(0o077);
const [op, path] = process.argv.slice(2),
  cfg = JSON.parse(await readFile(path, "utf8"));
const local = (key) => resolve(dirname(resolve(path)), cfg[key]),
  json = async (file) => JSON.parse(await readFile(file, "utf8"));
const wrangler = await json(local("bindings"));
if (
  !wrangler.r2_buckets?.some(
    (x) =>
      x.binding === "STATE" &&
      x.bucket_name === cfg.bucket &&
      x.remote === true,
  )
)
  throw Error("Unexpected home R2 binding");
const proxy = await getPlatformProxy({
  configPath: local("bindings"),
  remoteBindings: true,
  envFiles: [],
  persist: false,
});
try {
  const bucket = proxy.env.STATE;
  let result;
  switch (op) {
    case "read":
      result = await materializeHome(
        bucket,
        cfg.stable,
        cfg.direction,
        local("directory"),
        local("cache"),
        cfg.expected,
      );
      break;
    case "stage":
      result = await stageManifest(
        bucket,
        cfg.stable,
        local("sourceDirectory"),
        local("cache"),
        local("database"),
        await json(local("projection")),
      );
      break;
    case "publish": {
      if (
        !wrangler.services?.some(
          (x) =>
            x.binding === "HOME_CONTROL" &&
            x.entrypoint === "HistoryHomeMigrationApi" &&
            x.service ===
              (cfg.bucket === "laterdog-homes"
                ? "laterdog-home"
                : "laterdog-home-test") &&
            ["laterdog-homes", "laterdog-homes-test"].includes(cfg.bucket) &&
            x.remote === true,
        )
      )
        throw Error("Missing source home control binding");
      const nonce = (await readFile(local("nonceFile"), "utf8")).trim();
      if (
        !/^[0-9a-f]{64}$/.test(nonce) ||
        !/^[0-9a-f]{64}$/.test(cfg.physicalId) ||
        !cfg.boot ||
        !cfg.accountId
      )
        throw Error("Invalid source hold credentials");
      const permit = await (
        await bucket.get("homes/" + cfg.stable + "/history/home-cutover.json")
      )?.json();
      if (
        !permit ||
        permit.lease !== createHash("sha256").update(nonce).digest("hex") ||
        permit.machineId !== cfg.machineId ||
        permit.physicalId !== cfg.physicalId
      )
        throw Error("The history hold belongs to a different home");
      result = await publishManifest(
        bucket,
        cfg.stable,
        local("sourceDirectory"),
        cfg.target,
        cfg,
        () =>
          proxy.env.HOME_CONTROL.control(cfg.accountId, nonce, {
            op: "status",
          }),
      );
      break;
    }
    default:
      throw Error("Expected read, stage or publish");
  }
  console.log(JSON.stringify(result));
} finally {
  await proxy.dispose();
}
