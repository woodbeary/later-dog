import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

const blobs = new Map();
const store = createServer(async (request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  if (request.method === "PUT") {
    const pieces = [];
    for await (const part of request) pieces.push(part);
    blobs.set(path, Buffer.concat(pieces));
    response.writeHead(200).end();
    return;
  }
  const saved = blobs.get(path);
  if (!saved) return response.writeHead(404).end();
  response.writeHead(200, { "content-type": path.endsWith(".json") ? "application/json" : "application/octet-stream" });
  response.end(request.method === "HEAD" ? undefined : saved);
});
store.listen(0, "127.0.0.1");
await once(store, "listening");
const bootstrap = "S".repeat(43);
const env = {
  ...process.env,
  LATERDOG_STATE_URL: `http://127.0.0.1:${store.address().port}`,
  LATERDOG_STATE_TOKEN: "isolated-state-fixture",
  LATERDOG_SYNC_INTERVAL_MS: "600000",
  LATERDOG_CLOUD_ROLE: "home",
  LATERDOG_CLOUD_MACHINE_ID: "archive-image-fixture",
  LATERDOG_CLOUD_ADMIN_URL: "https://admin.example.test",
  LATERDOG_PUBLIC_URL: "https://archive-fixture.example.test",
  LATERDOG_CLOUD_BOOTSTRAP_SECRET: bootstrap,
};
const runtime = spawn(process.execPath, ["/app/cloud/runtime/run.mjs"], { env, stdio: "inherit" });
try {
  const smoke = spawn(process.execPath, ["/fixture/smoke.mjs"], {
    env: { ...process.env, HOME_URL: "http://127.0.0.1:8080", HOME_HOST: "archive-fixture.example.test",
      HOME_BOOTSTRAP_SECRET: bootstrap, HOME_EXPECT_LOG_ARCHIVE: "1" }, stdio: "inherit",
  });
  const [code] = await once(smoke, "exit");
  if (code !== 0) throw new Error(`image smoke failed: ${code}`);
  console.log(`isolated state service retained ${blobs.size} objects`);
} finally {
  runtime.kill("SIGTERM");
  await once(runtime, "exit");
  await new Promise(resolve => store.close(resolve));
}
