#!/usr/bin/env node
// Live end-to-end check of a deployed laterdog-computers Worker. It creates a computer, waits for it to boot, runs
// commands, writes and reads a file, takes a screenshot, opens the desktop viewer and its VNC WebSocket, puts the computer
// to sleep, wakes it, checks the file survived, and deletes it. Every step is timed.
//
//   node scripts/smoke.mjs [--out <dir>] [--keep] [--long]
//
// The API key is read from ~/.laterdog/computers-key and the API base from ~/.laterdog/computers.json; the key is never
// printed. --keep leaves the computer running at the end (delete it yourself), --long adds a 110-second command to show
// that long execs outlive the 100-second proxy limit some HTTP stacks have.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const outDir = option("--out", join(tmpdir(), "laterdog-computers-smoke"));
const key = (await readFile(join(homedir(), ".laterdog", "computers-key"), "utf8")).trim();
const { api } = JSON.parse(await readFile(join(homedir(), ".laterdog", "computers.json"), "utf8"));
const base = api.replace(/\/+$/, "");
await mkdir(outDir, { recursive: true });

const timings = {};
const failures = [];
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

function check(condition, what) {
  if (condition) log("  ok:", what);
  else {
    log("  FAIL:", what);
    failures.push(what);
  }
  return condition;
}

async function call(method, path, { body, headers = {}, raw = false, auth = true } = {}) {
  const init = { method, headers: { ...headers } };
  if (auth) init.headers.authorization = `Bearer ${key}`;
  if (body !== undefined) {
    if (body instanceof Uint8Array || typeof body === "string") init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
  }
  const response = await fetch(`${base}${path}`, init);
  if (raw) return response;
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, data };
}

async function timed(name, work) {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timings[name] = Math.round(performance.now() - started);
    log(`  ${name}: ${timings[name]} ms`);
  }
}

async function waitFor(id, wanted, limitMs) {
  const started = Date.now();
  let last;
  while (Date.now() - started < limitMs) {
    const { status, data } = await call("GET", `/computers/${id}`);
    last = data?.computer?.state ?? `HTTP ${status}`;
    if (last === wanted) return data.computer;
    if (last === "error") throw new Error(`computer entered error: ${data.computer.error}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`still ${last} after ${limitMs} ms`);
}

async function exec(id, command, extra = {}) {
  const { status, data } = await call("POST", `/computers/${id}/exec`, { body: { command, ...extra } });
  if (status !== 200) throw new Error(`exec ${JSON.stringify(command)} -> HTTP ${status} ${JSON.stringify(data)}`);
  return data;
}

function rfbGreeting(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("no RFB greeting within 15 s"));
    }, 15_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      socket.close();
      resolve(text);
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event.message ?? "connection failed"}`));
    });
  });
}

/**
 * The same WebSocket upgrade by hand, so the evidence is the literal answer: the HTTP status line (101), a valid
 * Sec-WebSocket-Accept, the first frame's bytes (the VNC server's RFB greeting), and then a round trip: our protocol
 * version goes up as a masked binary frame, as a browser's would, and the VNC server's list of security types comes back.
 */
function rawUpgrade(url) {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(`${nonce}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const req = httpsRequest(url, { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": nonce } });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("no complete answer within 15 s"));
    }, 15_000);
    req.on("upgrade", (res, socket, head) => {
      const result = { status: res.statusCode, acceptValid: res.headers["sec-websocket-accept"] === expected, opcode: undefined, banner: undefined, securityTypes: undefined };
      let buffer = head;
      let after = Buffer.alloc(0);
      const done = () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const step = () => {
        // Server frames are unmasked: byte 0 is FIN + opcode, byte 1 the length (these short messages need no extension).
        while (buffer.length >= 2 && (buffer[1] & 0x7f) < 126 && buffer.length >= 2 + (buffer[1] & 0x7f)) {
          const opcode = buffer[0] & 0x0f;
          const payload = buffer.subarray(2, 2 + (buffer[1] & 0x7f));
          buffer = buffer.subarray(2 + payload.length);
          if (result.banner === undefined) {
            result.opcode = opcode;
            result.banner = payload.toString("latin1");
            if (result.banner !== "RFB 003.008\n") return done();
            // Client frames are masked (RFC 6455): FIN + binary, mask bit + length, the 4-byte key, the masked bytes.
            const version = Buffer.from("RFB 003.008\n", "latin1");
            const mask = randomBytes(4);
            socket.write(Buffer.concat([Buffer.from([0x82, 0x80 | version.length]), mask, Buffer.from(version.map((byte, i) => byte ^ mask[i % 4]))]));
          } else {
            // RFB 3.8: one byte with the number of security types, then the types.
            after = Buffer.concat([after, payload]);
            if (after.length >= 1 && after.length >= 1 + after[0]) {
              result.securityTypes = [...after.subarray(1, 1 + after[0])];
              return done();
            }
          }
        }
      };
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        step();
      });
      step();
    });
    req.on("response", (res) => {
      clearTimeout(timer);
      res.resume();
      resolve({ status: res.statusCode, acceptValid: false, opcode: undefined, banner: undefined, securityTypes: undefined });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

log(`API ${base}`);

log("auth");
check((await call("GET", "/computers", { auth: false })).status === 401, "no key -> 401");
check((await call("GET", "/computers", { auth: false, headers: { authorization: "Bearer ldc_wrong" } })).status === 401, "wrong key -> 401");
check((await call("GET", "/computers", { headers: { origin: "https://example.com" } })).status === 403, "Origin header -> 403");
const listed = await call("GET", "/computers");
check(listed.status === 200 && Array.isArray(listed.data.computers), `list -> 200 (${listed.data.computers?.length} computers)`);

const idempotencyKey = `smoke-${Date.now()}`;
log("create");
const created = await timed("create_request", () => call("POST", "/computers", { body: { name: "smoke test", size: "standard" }, headers: { "idempotency-key": idempotencyKey } }));
check(created.status === 201, `create -> ${created.status}`);
const id = created.data.computer?.id;
if (!id) {
  console.error(JSON.stringify(created.data));
  process.exit(1);
}
log(`  computer ${id}: ${JSON.stringify(created.data.computer)}`);
const replay = await call("POST", "/computers", { body: { name: "smoke test", size: "standard" }, headers: { "idempotency-key": idempotencyKey } });
check(replay.status === 201 && replay.data.computer?.id === id && replay.headers.get("idempotent-replayed") === "true", "same Idempotency-Key -> same computer");

let deleted = false;
try {
  log("boot");
  const createdAt = Date.now();
  await timed("boot_to_running", () => waitFor(id, "running", 6 * 60_000));
  timings.boot_from_create_ms = Date.now() - createdAt;

  log("exec");
  const hello = await timed("exec_uname_whoami_display", () => exec(id, "uname -a && whoami && echo $DISPLAY"));
  log(`  stdout: ${hello.stdout.trim().replaceAll("\n", " | ")}`);
  const helloLines = hello.stdout.trim().split("\n");
  check(hello.exitCode === 0 && helloLines.at(-2) === "dog" && helloLines.at(-1) === ":0", "uname -a && whoami && echo $DISPLAY runs as dog on :0");
  const facts = await exec(id, [
    "echo id=$(id)",
    "echo display=$DISPLAY geometry=$(xdotool getdisplaygeometry)",
    "echo cpus=$(nproc) mem=$(free -m | awk '/Mem:/{print $2}')MiB disk=$(df -h / | awk 'NR==2{print $2\" size, \"$4\" free\"}')",
    "unshare --user --map-root-user true 2>/dev/null && echo userns=available || echo userns=refused",
    "sudo -n true && echo sudo=ok",
    "echo bus=$(busctl --user list >/dev/null 2>&1 && echo ok || (dbus-send --session --dest=org.freedesktop.DBus --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1 && echo ok || echo missing))",
  ].join("; "));
  for (const line of facts.stdout.trim().split("\n")) log(`  ${line}`);
  check(facts.stdout.includes("geometry=1280 800"), "xdotool sees the 1280x800 display");

  log("files");
  const content = `hello from later.dog ${new Date().toISOString()}\n`;
  const put = await timed("file_put", () => call("PUT", `/computers/${id}/files?path=${encodeURIComponent("/home/dog/smoke/hello.txt")}`, { body: content }));
  check(put.status === 200 && put.data.ok === true, "PUT /home/dog/smoke/hello.txt");
  const got = await timed("file_get", () => call("GET", `/computers/${id}/files?path=${encodeURIComponent("/home/dog/smoke/hello.txt")}`, { raw: true }));
  check(got.status === 200 && (await got.text()) === content, "GET returns the same bytes");
  const owner = await exec(id, "stat -c '%U:%G' /home/dog/smoke /home/dog/smoke/hello.txt");
  check(owner.stdout.trim().split("\n").every((line) => line === "dog:dog"), `new folder and file owned by dog (${owner.stdout.trim().replaceAll("\n", ", ")})`);
  check((await call("GET", `/computers/${id}/files?path=/home/dog/nope.txt`)).status === 404, "missing file -> 404");

  log("browser");
  const browser = await exec(id, "setsid -f chromium https://example.com >/dev/null 2>&1; for i in $(seq 1 30); do xdotool search --onlyvisible --class chromium >/dev/null 2>&1 && break; sleep 1; done; sleep 3; xdotool search --onlyvisible --class chromium getwindowname 2>/dev/null | head -1", { timeoutMs: 60_000 });
  log(`  chromium window: ${browser.stdout.trim() || "(none)"}`);
  check(browser.stdout.includes("Chromium"), "Chromium opened a window");

  log("screenshot");
  const shot = await timed("screenshot", () => call("GET", `/computers/${id}/screenshot`, { raw: true }));
  const jpeg = new Uint8Array(await shot.arrayBuffer());
  const shotPath = join(outDir, `${id}-awake.jpg`);
  await writeFile(shotPath, jpeg);
  check(shot.status === 200 && shot.headers.get("content-type") === "image/jpeg" && jpeg[0] === 0xff && jpeg[1] === 0xd8, `screenshot is a JPEG (${jpeg.byteLength} bytes) -> ${shotPath}`);

  log("desktop viewer");
  const link = await timed("desktop_link", () => call("POST", `/computers/${id}/desktop`));
  check(link.status === 200 && typeof link.data.url === "string", `desktop link, expires ${link.data.expiresAt}`);
  const viewerUrl = link.data.url;
  const page = await timed("viewer_page", () => fetch(viewerUrl));
  const html = await page.text();
  check(page.status === 200 && html.includes('import RFB from "./core/rfb.js"'), `viewer page -> ${page.status}`);
  const module = await fetch(new URL("core/rfb.js", viewerUrl));
  check(module.status === 200 && (await module.text()).includes("export default class RFB"), `core/rfb.js through the signed path -> ${module.status}`);
  const status = await fetch(new URL("status", viewerUrl)).then((r) => r.json());
  check(status.state === "running", `viewer status -> ${JSON.stringify(status)}`);
  const socketUrl = new URL("websockify", viewerUrl);
  socketUrl.protocol = "wss:";
  const greeting = await timed("websocket_rfb_greeting", () => rfbGreeting(socketUrl.href));
  check(greeting === "RFB 003.008\n", `WebSocket delivers ${JSON.stringify(greeting)}`);
  const raw = await timed("websocket_raw_upgrade", () => rawUpgrade(new URL("websockify", viewerUrl).href));
  check(raw.status === 101 && raw.acceptValid, `raw upgrade -> HTTP ${raw.status}, Sec-WebSocket-Accept ${raw.acceptValid ? "valid" : "invalid"}`);
  check(raw.opcode === 2 && raw.banner === "RFB 003.008\n", `first frame (opcode ${raw.opcode}, binary is 2) carries ${JSON.stringify(raw.banner)}`);
  check(Array.isArray(raw.securityTypes) && raw.securityTypes.includes(1), `our protocol version reached the VNC server, which answered security types ${JSON.stringify(raw.securityTypes)} (1 = none)`);
  const forged = new URL(viewerUrl);
  forged.pathname = forged.pathname.replace(/\.[A-Za-z0-9_-]{43}\/$/, `.${"A".repeat(43)}/`);
  check((await fetch(forged)).status === 403, "forged link -> 403");

  log("exec timeout");
  const slow = await timed("exec_timeout_2s", () => exec(id, "sleep 30; echo late", { timeoutMs: 2000 }));
  check(slow.timedOut === true && slow.exitCode === 124, `sleep 30 with timeoutMs 2000 -> exit ${slow.exitCode}, timedOut ${slow.timedOut}`);
  if (flag("--long")) {
    const long = await timed("exec_110s", () => exec(id, "sleep 110; echo finished", { timeoutMs: 150_000 }));
    check(long.exitCode === 0 && long.stdout.trim() === "finished", "a 110-second command returns its output");
  }

  log("sleep");
  const slept = await timed("sleep_request", () => call("POST", `/computers/${id}/sleep`));
  check(slept.status === 200 && slept.data.computer?.state === "sleeping" && slept.data.computer?.snapshotAt, `sleep -> ${JSON.stringify(slept.data.computer ?? slept.data)}`);
  const asleepExec = await call("POST", `/computers/${id}/exec`, { body: { command: "true" } });
  check(asleepExec.status === 409 && asleepExec.data.error?.code === "asleep", "exec while asleep -> 409 asleep");
  check((await fetch(viewerUrl)).status === 409, "viewer while asleep -> 409");

  log("wake");
  const wakeStarted = Date.now();
  const woke = await timed("wake_request", () => call("POST", `/computers/${id}/wake`));
  check(woke.status === 200 && woke.data.computer?.state === "starting", `wake -> ${woke.data.computer?.state}`);
  await timed("wake_to_running", () => waitFor(id, "running", 6 * 60_000));
  timings.wake_total_ms = Date.now() - wakeStarted;
  const again = await call("GET", `/computers/${id}/files?path=${encodeURIComponent("/home/dog/smoke/hello.txt")}`, { raw: true });
  check(again.status === 200 && (await again.text()) === content, "the file survived sleep and wake");
  check((await fetch(viewerUrl)).status === 403, "the old desktop link died with the old boot -> 403");
  const drawn = await exec(id, "xdotool search --onlyvisible --class '^xfce4-panel$' >/dev/null && xdotool search --onlyvisible --class '^xfdesktop$' >/dev/null && echo drawn");
  check(drawn.stdout.trim() === "drawn", "the desktop (panel and wallpaper) is drawn as soon as the computer is running again");
  const after = await call("GET", `/computers/${id}/screenshot`, { raw: true });
  const afterPath = join(outDir, `${id}-after-wake.jpg`);
  await writeFile(afterPath, new Uint8Array(await after.arrayBuffer()));
  check(after.status === 200, `screenshot after wake -> ${afterPath}`);

  if (flag("--keep")) {
    log(`keeping ${id} (delete it with DELETE ${base}/computers/${id})`);
  } else {
    log("delete");
    const gone = await timed("delete", () => call("DELETE", `/computers/${id}`));
    check(gone.status === 200 && gone.data.deleted === true, "delete -> { deleted: true }");
    check((await call("GET", `/computers/${id}`)).status === 404, "deleted computer -> 404");
    deleted = true;
  }
} catch (error) {
  failures.push(String(error));
  log("ERROR", error);
} finally {
  if (!deleted && !flag("--keep")) {
    const cleanup = await call("DELETE", `/computers/${id}`).catch((error) => ({ status: String(error) }));
    log(`cleanup delete of ${id}: ${cleanup.status}`);
  }
}

console.log(JSON.stringify({ id, timings, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
