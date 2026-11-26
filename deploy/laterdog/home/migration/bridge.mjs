import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getPlatformProxy } from "wrangler";
import { authorizedState, handleState } from "../src/state.ts";
import { handleWorkFolder } from "../src/work-folder-store.ts";
import { handleWorkFolderPlacement, workFolderControlPath } from "../src/work-folder-placement.ts";

const [configPath, account, bucketName, stable, rawPort, output] = process.argv.slice(2);
if (!configPath || !/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]+$/.test(bucketName) || !/^[a-f0-9]{64}$/.test(stable) || !/^\d+$/.test(rawPort) || !output) {
  throw new Error("Expected config.json, account ID, bucket name, stable home namespace, fixed local port and exclusive private authority file");
}
const config = JSON.parse(await readFile(configPath, "utf8"));
const bindings = config.r2_buckets;
if (config.account_id !== account || !Array.isArray(bindings) || bindings.length !== 1 || bindings[0].binding !== "STATE" || bindings[0].bucket_name !== bucketName || bindings[0].remote !== true) throw new Error("Remote R2 account or bucket differs from the requested scope");
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local migration port");
const origin = "http://127.0.0.1:" + port;
const bootstrap = randomBytes(32).toString("base64url");
const controlToken = randomBytes(32).toString("base64url");
const identity = createHash("sha256").update(JSON.stringify([account, bucketName, stable])).digest("hex");
const proxy = await getPlatformProxy({ configPath, envFiles: [], persist: false, remoteBindings: true });
const remote = proxy.env.STATE;
const bucket = {
  get: key => remote.get(key),
  head: key => remote.head(key),
  list: options => remote.list(options),
  delete: keys => remote.delete(keys),
  async put(key, value, options) {
    return remote.put(key, value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value, options);
  },
};

async function handle(req) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/work-folders/v1/")) {
    if (/\/(?:grant|revoke|refresh)$/.test(url.pathname)) return new Response(null, { status: 405 });
    return handleWorkFolder(req, bucket, stable, origin, bootstrap);
  }
  if (!await authorizedState(req, controlToken)) return new Response(null, { status: 401 });
  if (workFolderControlPath(url.pathname)) return handleWorkFolderPlacement(req, bucket, stable);
  if ((req.method === "GET" || req.method === "HEAD") && ["/manifest.json", "/archive/index.json"].includes(url.pathname)) return handleState(req, bucket, stable);
  if (/^\/(?:archive\/)?blobs\/[a-f0-9]{64}$/.test(url.pathname) && ["GET", "HEAD", "PUT"].includes(req.method)) return handleState(req, bucket, stable);
  return new Response(null, { status: 404 });
}

const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== new URL(origin).host) { outgoing.writeHead(400).end(); return; }
    const options = { method: incoming.method, headers: incoming.headers };
    if (incoming.method !== "GET" && incoming.method !== "HEAD") Object.assign(options, { body: Readable.toWeb(incoming), duplex: "half" });
    const response = await handle(new Request(new URL(incoming.url, origin), options));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
    else outgoing.end();
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
    process.stderr.write((error instanceof Error ? error.name : "Bridge failure") + "\n");
  }
});

let created = false;
try {
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  await writeFile(output, JSON.stringify({ origin, bootstrap, controlOrigin: origin, controlToken, identity }), { mode: 0o600, flag: "wx" });
  created = true;
  process.stdout.write(JSON.stringify({ ready: true, origin, identity }) + "\n");
  await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
} finally {
  await new Promise(resolve => server.close(resolve));
  if (created) await unlink(output);
  await proxy.dispose();
}
