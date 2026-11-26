import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import { capture, hex, readCatalog } from "./package.mjs";
import { transferPackedReceipts } from "./receipts.mjs";
import { compact, reconstruct } from "./projection.mjs";
import { exportFrozen, publishCatalog } from "./transfer.mjs";

process.umask(0o077);
const [action, configPath] = process.argv.slice(2);
const cfg = JSON.parse(await readFile(configPath, "utf8"));
const local = (key) => resolve(dirname(resolve(configPath)), cfg[key]);
const data = local("package");
async function remote() {
  if (
    !hex.test(cfg.stable) ||
    typeof cfg.generation !== "string" ||
    !cfg.generation
  )
    throw Error("Invalid history migration identity");
  const configPath = local("bindings");
  const bindings = JSON.parse(await readFile(configPath, "utf8"));
  const service = bindings.services?.find((x) => x.binding === "HISTORY_ADMIN");
  if (
    service?.entrypoint !== "HistoryMigrationApi" ||
    !["laterdog-history", "laterdog-history-test"].includes(service.service) ||
    service.remote !== true
  )
    throw Error("Unexpected migration binding");
  const proxy = await getPlatformProxy({
    configPath,
    remoteBindings: true,
    persist: false,
    envFiles: [],
  });
  const admin = proxy.env.HISTORY_ADMIN;
  const args = (q) => ({ generation: cfg.generation, ...q });
  const api = {
    admin: (q) => admin.admin(cfg.stable, args(q)),
    receiptBatch: (q) => admin.receiptBatch(cfg.stable, cfg.generation, q),
    putReceiptPack: (meta, body) => admin.putReceiptPack(cfg.stable,cfg.generation,meta,body),
    getReceipt: (sha) => admin.getReceipt(cfg.stable, cfg.generation, sha),
    putReceipt: (sha, body) =>
      admin.putReceipt(cfg.stable, cfg.generation, sha, body),
    importStream: (req, stream) =>
      admin.importStream(cfg.stable, args(req), stream),
    async page(req) {
      const { op, ...body } = req;
      if (op !== "page") throw Error("Invalid history page request");
      return new Response(
        await admin.pageStream(cfg.stable, args(body)),
      ).json();
    },
  };
  return { api, close: () => proxy.dispose() };
}
let receipt;
if (action === "capture")
  receipt = await capture(local("source"), data, {
    portable: cfg.preserveAllocatedRowids === true,
  });
else if (action === "compact")
  receipt = await compact(
    local("source"),
    data,
    cfg.catalog,
    local("output"),
    cfg.generation,
  );
else if (
  ["status", "reconstruct", "import", "export-frozen", "pack-receipts"].includes(action)
) {
  const { api, close } = await remote();
  try {
    if (action === "status") {
      const placement = await api.admin({ op: "status" });
      receipt = {
        mode: await placement.mode,
        revision: await placement.revision,
        generation: await placement.generation,
      };
    } else if (action === "pack-receipts") {
      const source = readCatalog(data, cfg.catalog);
      const placement = await api.admin({ op: "status" });
      if (
        (await placement.mode) !== "dual" ||
        (await placement.generation) !== cfg.generation ||
        (await placement.revision) !== cfg.expectedRevision + 1
      ) throw Error("History preparation changed before packed receipt upload");
      const identity = {stable: cfg.stable, generation: cfg.generation, expectedRevision: cfg.expectedRevision};
      const target = JSON.parse(await readFile(resolve(local("journal"),"target.json")));
      if (target.stable !== identity.stable || target.generation !== identity.generation || target.expectedRevision !== identity.expectedRevision) throw Error("Packed receipt journal belongs to a different target");
      receipt = await transferPackedReceipts(api,data,source.receipts,local("journal"),identity,cfg.concurrency ?? 4);
    } else if (action === "reconstruct")
      receipt = await reconstruct(
        local("source"),
        data,
        cfg.catalog,
        local("output"),
        cfg.generation,
        api,
      );
    else if (action === "import")
      receipt = await publishCatalog(
        api,
        data,
        cfg.catalog,
        local("journal"),
        cfg,
      );
    else receipt = await exportFrozen(api, data, cfg);
  } finally {
    await close();
  }
} else
  throw Error(
    "Expected capture, compact, import, export-frozen, pack-receipts or reconstruct",
  );
console.log(JSON.stringify(receipt));
