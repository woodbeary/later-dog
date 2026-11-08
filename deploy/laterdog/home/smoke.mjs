import { createHash, createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const base = process.env.HOME_URL ?? "http://127.0.0.1:8080";
const host = process.env.HOME_HOST;
const secret = process.env.HOME_BOOTSTRAP_SECRET;
if (!host || !secret) throw new Error("HOME_HOST and HOME_BOOTSTRAP_SECRET are required");

const headers = { host, "x-laterdog-client-ip": "203.0.113.5" };

function request(url, options = {}) {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : target.protocol === "http:" ? httpRequest : null;
  if (!send) throw new Error("HOME_URL must use HTTP or HTTPS");
  return new Promise((resolve, reject) => {
    const pending = send(target, { method: options.method ?? "GET", headers: options.headers }, (incoming) => {
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      }
      resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode, headers: responseHeaders }));
    });
    pending.on("error", reject);
    pending.setTimeout(15_000, () => pending.destroy(new Error("home request timed out")));
    pending.end(options.body);
  });
}

async function until(what, check, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`timed out waiting for ${what} ${last}`);
}

function signature(timestamp, nonce, body) {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\nPOST\n/api/cloud/pairing\n${bodyHash}`).digest("base64url");
}

await until("the home to answer its health check", async () => {
  const response = await request(`${base}/api/health`, { headers });
  const body = await response.json();
  return response.ok && body.app === "laterdog";
});
console.log("health: ok");

const refused = await request(`${base}/api/bots`, { headers: { ...headers, host: "someone-else.example" } });
if (refused.status !== 403) throw new Error(`another host should be refused, got ${refused.status}`);
await refused.body?.cancel();
console.log("other hosts: refused");

const anonymous = await request(`${base}/api/bots`, { headers });
const anonymousBody = await anonymous.json().catch(() => null);
if (anonymous.status !== 403 || anonymousBody?.error !== "forbidden: this request came through a proxy (pair this device to use the server remotely)") {
  throw new Error(`an unpaired request should reach the home and receive its JSON pairing refusal, got ${anonymous.status}`);
}
console.log("unpaired requests: refused by the home");

const body = JSON.stringify({ label: "later.dog smoke test", ttlSeconds: 120 });
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(18).toString("base64url");
const paired = await request(`${base}/api/cloud/pairing`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json", "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce, "x-laterdog-cloud-signature": `v1=${signature(timestamp, nonce, body)}` },
  body,
});
const grant = await paired.json().catch(() => null);
if (!paired.ok || typeof grant?.code !== "string") throw new Error(`signed pairing failed: ${paired.status}`);
console.log("signed pairing: ok");

const redeemed = await request(`${base}/api/auth/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code: grant.code, label: "later.dog smoke test" }) });
const session = await redeemed.json().catch(() => null);
if (!redeemed.ok || typeof session?.token !== "string") throw new Error(`pairing code was not redeemed: ${redeemed.status}`);
console.log("phone session: ok");

const bots = await request(`${base}/api/bots?messages=0`, { headers: { ...headers, authorization: `Bearer ${session.token}` } });
const list = await bots.json().catch(() => null);
if (!bots.ok || !Array.isArray(list?.bots)) throw new Error(`the owner could not list dogs: ${bots.status}`);
console.log(`dogs: ${list.bots.length}`);

if (process.env.HOME_EXPECT_LOG_ARCHIVE === "1") {
  if (host !== "archive-fixture.example.test" || process.env.HOME !== "/data") throw new Error("archive smoke requires its disposable image fixture");
  const { mkdir, writeFile, utimes, readFile, access } = await import("node:fs/promises");
  const authorized = { ...headers, authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  const storage = async () => {
    const response = await request(`${base}/api/storage`, { headers: authorized });
    if (!response.ok) throw new Error("storage report unavailable");
    return response.json();
  };
  if (!(await storage()).archive?.enabled) throw new Error("runtime archive bridge is not active");
  console.log("runtime archive bridge: active");
  const known = list.bots[0];
  const id = known?.threadId ?? known?.activeTaskId ?? known?.tasks?.[0]?.threadId;
  if (typeof id !== "string") throw new Error("isolated idle thread is missing");
  const paths = [`/data/.laterdog/events/${id}.ndjson`, `/data/.laterdog/native/${id}.ndjson`];
  const content = [
    JSON.stringify({ eventId: "archive-fixture-event", provider: "claudeAgent", providerInstanceId: "claude", threadId: id,
      turnId: "old-turn", createdAt: new Date(0).toISOString(), type: "content.delta", streamKind: "assistant_text", delta: "x".repeat(1024 * 1024) }) + "\n",
    JSON.stringify({ at: new Date(0).toISOString(), dir: "in", source: "fixture", msg: { text: "n".repeat(1024 * 1024) } }) + "\n",
  ];
  for (let at = 0; at < paths.length; at++) {
    await mkdir(paths[at].slice(0, paths[at].lastIndexOf("/")), { recursive: true });
    await writeFile(paths[at], content[at]);
    await utimes(paths[at], new Date(0), new Date(0));
  }
  const result = await until("automatic log archive", async () => {
    const current = await storage();
    return current.archive?.archivedFiles >= 2 && current.archive.freeAfter !== null ? current.archive : null;
  }, 180);
  for (const path of paths) if (await access(path).then(() => true, () => false)) throw new Error("archived log was not removed");
  const history = await request(`${base}/api/threads/${id}/events`, { headers: authorized });
  if (!history.ok) throw new Error("archived event history did not return");
  await history.arrayBuffer();
  for (let at = 0; at < paths.length; at++) if (await readFile(paths[at], "utf8") !== content[at]) throw new Error("restored image log bytes changed");
  console.log(`image archive and history restore: ${JSON.stringify(result)}`);
}

const stream = await request(`${base}/api/events?screens=off`, { headers: { ...headers, authorization: `Bearer ${session.token}`, accept: "text/event-stream" } });
if (!stream.ok || !stream.body || !stream.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error(`live updates failed: ${stream.status}`);
const reader = stream.body.getReader();
let timer;
try {
  const first = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no live update within 10s")), 10_000); })]);
  if (first.done || !new TextDecoder().decode(first.value).includes("hello")) throw new Error("the live stream did not say hello");
} finally {
  clearTimeout(timer);
  await reader.cancel();
}
console.log("live updates: ok");
