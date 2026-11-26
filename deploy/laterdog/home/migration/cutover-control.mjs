import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { getPlatformProxy } from "wrangler";

const execute = promisify(execFile);
const [configPath, operation, selection] = process.argv.slice(2);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identifier = /^[a-f0-9]{64}$/;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const config = await json(resolve(configPath));
const relative = (path) => resolve(dirname(resolve(configPath)), path);
const lease = (await readFile(relative(config.leaseFile), "utf8")).trim();
const journal = relative(config.journalDir);
if (
  !identifier.test(lease) ||
  !identifier.test(config.stable) ||
  !identifier.test(config.physicalId) ||
  typeof config.accountId !== "string" ||
  !config.accountId ||
  !/^h[a-f0-9]{24}$/.test(config.machineId)
) {
  throw Error("Invalid cutover scope");
}
const ops = new Set([
  "status",
  "begin",
  "hold",
  "renew",
  "snapshot",
  "abort",
  "retire",
]);
if (
  !ops.has(operation) ||
  (selection && (operation !== "retire" || !identifier.test(selection)))
)
  throw Error("Invalid cutover operation");
await mkdir(journal, { recursive: true, mode: 0o700 });

async function save(name, data) {
  const destination = join(journal, name + ".json"),
    temporary = destination + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

async function source() {
  try {
    return await json(join(journal, "source.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function publicReceipt(result) {
  const {
    phase,
    revision,
    sourceDisk,
    baselineManifest,
    expiresAt,
    sha256,
    entries,
    uploaded,
    configuredImage,
  } = result;
  const disk = result.disk
    ? {
        boot: result.disk.boot,
        mountId: result.disk.mountId,
        phase: result.disk.phase,
        remaining: result.disk.remaining,
        stopped: result.disk.stopped,
      }
    : undefined;
  return {
    at: new Date().toISOString(),
    phase,
    revision,
    sourceDisk,
    disk,
    baselineManifest,
    expiresAt,
    sha256,
    entries,
    uploaded,
    configuredImage,
  };
}

async function invoke(op) {
  const bindings = relative(config.bindings);
  const b = await json(bindings);
  if (
    !b.services?.some(
      (s) =>
        s.binding === "CUTOVER" &&
        s.entrypoint === "WorkFolderMigrationApi" &&
        s.remote === true,
    ) ||
    !b.r2_buckets?.some((s) => s.binding === "STATE" && s.remote === true)
  )
    throw Error("Missing private cutover bindings");
  const w = await getPlatformProxy({
    configPath: bindings,
    envFiles: [],
    persist: false,
    remoteBindings: true,
  });
  try {
    const enrollment = await (
      await w.env.STATE.get(
        "homes/" + config.stable + "/work-folders/cutover-enrollment",
      )
    )?.json();
    if (
      enrollment?.machineId !== config.machineId ||
      enrollment.lease !== lease
    )
      throw Error("The selected home has a different cutover enrollment");
    const active = await source();
    if (
      active &&
      (active.leaseSha256 !== hash(lease) ||
        active.stable !== config.stable ||
        active.physicalId !== config.physicalId)
    )
      throw Error("This journal belongs to another release");
    const call = (request) =>
      w.env.CUTOVER.cutover(config.accountId, lease, request);
    if (!["begin", "status"].includes(op) && !active)
      throw Error("This operation requires the original source journal");
    if (["renew", "snapshot", "abort", "retire"].includes(op)) {
      const before = await call({ op: "status" });
      if (
        (before.stable && before.stable !== config.stable) ||
        (before.machineId && before.machineId !== config.machineId)
      )
        throw Error("Cutover source changed");
      if (before.disk?.phase === "held" || before.disk?.phase === "sealed") {
        if (
          before.sourceDisk !== active.sourceDisk ||
          before.disk.mountId !== active.disk.mountId
        )
          throw Error("The original frozen disk changed");
      }
      if (
        op === "renew" &&
        ["committed", "retired", "open"].includes(before.phase)
      )
        return publicReceipt(before);
      if (op === "renew" && before.phase !== "held")
        throw Error("The original source lease ended");
    }
    const result = await call({ op, ...(selection ? { selection } : {}) });
    const receipt = publicReceipt(result);
    if (op === "begin") {
      if (
        result.phase !== "held" ||
        result.disk?.phase !== "held" ||
        result.sourceDisk !== config.physicalId + "/" + result.disk.boot ||
        (active &&
          (active.sourceDisk !== result.sourceDisk ||
            active.disk.mountId !== result.disk.mountId))
      )
        throw Error("The new lease does not match the journaled original disk");
      await save("source", {
        ...receipt,
        leaseSha256: hash(lease),
        stable: config.stable,
        physicalId: config.physicalId,
      });
    } else await save(op, receipt);
    return receipt;
  } finally {
    await w.dispose();
  }
}

async function fresh(op, timeout) {
  const { stdout } = await execute(
    process.execPath,
    [import.meta.filename, resolve(configPath), op],
    { timeout, maxBuffer: 128 * 1024, env: process.env },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

if (operation === "hold") {
  const first = await fresh("begin", 60_000);
  let expires = first.expiresAt,
    snapshotError;
  const pendingSnapshot = fresh(
    "snapshot",
    Math.max(60_000, config.snapshotTimeoutMs ?? 3600_000),
  ).catch((error) => {
    snapshotError = error;
  });
  for (;;) {
    await sleep(10_000);
    if (snapshotError)
      throw Error(
        "The frozen snapshot did not complete; the source lease will expire",
        { cause: snapshotError },
      );
    try {
      const receipt = await fresh("renew", 15_000);
      if (["committed", "retired", "open"].includes(receipt.phase)) {
        await pendingSnapshot;
        console.log(JSON.stringify(receipt));
        if (receipt.phase === "open") process.exitCode = 2;
        break;
      }
      expires = receipt.expiresAt;
    } catch (error) {
      if (Date.now() + 3000 >= expires)
        throw Error(
          "The source lease could not be confirmed; reconcile the journal before proceeding",
          { cause: error },
        );
    }
  }
} else console.log(JSON.stringify(await invoke(operation)));
