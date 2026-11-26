import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import { capture, hex } from "./package.mjs";
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
if (action === "capture") receipt = await capture(local("source"), data);
else if (action === "compact")
  receipt = await compact(
    local("source"),
    data,
    cfg.catalog,
    local("output"),
    cfg.generation,
  );
else if (action === "reconstruct")
  receipt = await reconstruct(
    local("source"),
    data,
    cfg.catalog,
    local("output"),
    cfg.generation,
  );
else if (action === "import" || action === "export-frozen") {
  const { api, close } = await remote();
  try {
    receipt =
      action === "import"
        ? await publishCatalog(api, data, cfg.catalog, local("journal"), cfg)
        : await exportFrozen(api, data, cfg);
  } finally {
    await close();
  }
} else
  throw Error(
    "Expected capture, compact, import, export-frozen or reconstruct",
  );
console.log(JSON.stringify(receipt));
