import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.LATERDOG_BOX_PORT || 7070);
const MAX_DESKTOPS = Number(process.env.LATERDOG_BOX_DESKTOPS || 6);
const IDLE_MS = Number(process.env.LATERDOG_BOX_IDLE_SECONDS || 900) * 1000;
const GEOMETRY = process.env.DESKTOP_GEOMETRY || "1280x800";
const PROFILES = process.env.LATERDOG_BOX_PROFILES || "/home/dog/box";
const DOG = /^[\w-]{1,64}$/;
const started = Date.now();
const desktops = new Map();

const asDog = (display, command) => ["runuser", "-u", "dog", "--", "env", "HOME=/home/dog", "USER=dog", "LOGNAME=dog", `DISPLAY=:${display}`, "NO_AT_BRIDGE=1", ...command];

function launch(desktop, argv) {
  const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: true });
  child.on("exit", () => { desktop.exited = (desktop.exited || 0) + 1; });
  desktop.children.push(child);
  return child;
}

const freeSlot = () => {
  const used = new Set([...desktops.values()].map((desktop) => desktop.slot));
  for (let slot = 1; slot <= MAX_DESKTOPS; slot += 1) if (!used.has(slot)) return slot;
  return null;
};

const waitFor = (check, ms = 8000) => new Promise((resolve) => {
  const until = Date.now() + ms;
  const tick = () => execFile(check[0], check.slice(1), (error) => {
    if (!error) resolve(true);
    else if (Date.now() > until) resolve(false);
    else setTimeout(tick, 100);
  });
  tick();
});

async function open(dog) {
  const known = desktops.get(dog);
  if (known) { known.usedAt = Date.now(); return view(dog, known); }
  const slot = freeSlot();
  if (slot === null) return null;
  const display = 10 + slot;
  const desktop = { dog, slot, display, vncPort: 5900 + display, wsPort: 6100 + slot, children: [], openedAt: Date.now(), usedAt: Date.now(), exited: 0 };
  desktops.set(dog, desktop);
  rmSync(`/tmp/.X${display}-lock`, { force: true });
  rmSync(`/tmp/.X11-unix/X${display}`, { force: true });
  const profile = join(PROFILES, dog, "chromium");
  mkdirSync(profile, { recursive: true });
  execFile("chown", ["-R", "dog:dog", join(PROFILES, dog)], () => {});
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(profile, lock), { force: true });
  launch(desktop, ["Xvfb", `:${display}`, "-screen", "0", `${GEOMETRY}x24`, "-nolisten", "tcp", "-ac", "-s", "0", "-dpms"]);
  const up = await waitFor(["xdpyinfo", "-display", `:${display}`]);
  if (!up) { await close(dog); throw new Error("display did not start"); }
  launch(desktop, ["x11vnc", "-display", `:${display}`, "-forever", "-shared", "-nopw", "-localhost", "-rfbport", String(desktop.vncPort), "-xkb", "-noxdamage", "-quiet"]);
  launch(desktop, ["laterdog-websockify", `0.0.0.0:${desktop.wsPort}`, `localhost:${desktop.vncPort}`]);
  launch(desktop, asDog(display, ["xfwm4"]));
  launch(desktop, asDog(display, ["chromium", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--disable-dev-shm-usage", "--hide-crash-restore-bubble", "--start-maximized"]));
  return view(dog, desktop);
}

const exited = (child, ms) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
  const timer = setTimeout(() => resolve(false), ms);
  child.once("exit", () => { clearTimeout(timer); resolve(true); });
});

function browserMains(profile) {
  const pids = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let args;
    try { args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0"); } catch { continue; }
    if (args.includes(`--user-data-dir=${profile}`) && !args.some((arg) => arg.startsWith("--type="))) pids.push(Number(entry));
  }
  return pids;
}

const browserGone = (profile, ms) => new Promise((resolve) => {
  const until = Date.now() + ms;
  const tick = () => execFile("pgrep", ["-f", "--", `--user-data-dir=${profile}`], (error) => {
    if (error) resolve(true);
    else if (Date.now() > until) resolve(false);
    else setTimeout(tick, 200);
  });
  tick();
});

async function close(dog) {
  const desktop = desktops.get(dog);
  if (!desktop) return false;
  desktops.delete(dog);
  const profile = join(PROFILES, dog, "chromium");
  for (const pid of browserMains(profile)) { try { process.kill(pid, "SIGTERM"); } catch {} }
  if (!(await browserGone(profile, 20_000))) await run("pkill", ["-KILL", "-f", "--", `--user-data-dir=${profile}`]);
  for (const child of [...desktop.children].reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    if (!(await exited(child, 10_000))) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  }
  return true;
}

const view = (dog, desktop) => ({ dog, display: desktop.display, viewerPort: desktop.wsPort, openedAt: desktop.openedAt, idleMs: Date.now() - desktop.usedAt, restarts: desktop.exited });

function memory() {
  try {
    const info = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map((line) => { const [key, value] = line.split(":"); return [key, Number.parseInt(value, 10) * 1024]; }));
    return { totalBytes: info.MemTotal, availableBytes: info.MemAvailable };
  } catch { return null; }
}

const screenshot = (desktop) => new Promise((resolve) => {
  const file = join(tmpdir(), `box-${desktop.display}-${Date.now()}.png`);
  execFile("scrot", ["-o", file], { env: { ...process.env, DISPLAY: `:${desktop.display}` }, timeout: 10_000 }, (error) => {
    if (error) return resolve(null);
    try { resolve(readFileSync(file)); } catch { resolve(null); } finally { rmSync(file, { force: true }); }
  });
});

setInterval(() => {
  for (const [dog, desktop] of desktops) if (Date.now() - desktop.usedAt > IDLE_MS) void close(dog);
}, 60_000).unref();

const readBody = (req) => new Promise((resolve) => {
  let text = "";
  req.on("data", (chunk) => { text += chunk; if (text.length > 16_384) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(text || "{}")); } catch { resolve(null); } });
});

function xdotool(desktop, args) {
  return new Promise((resolve) => execFile("xdotool", args, { env: { ...process.env, DISPLAY: `:${desktop.display}` }, timeout: 15_000 }, (error) => resolve(!error)));
}

async function input(desktop, body) {
  if (!body || typeof body.action !== "string") return false;
  if (body.action === "click" && Number.isInteger(body.x) && Number.isInteger(body.y)) return xdotool(desktop, ["mousemove", "--sync", String(body.x), String(body.y), "click", "1"]);
  if (body.action === "type" && typeof body.text === "string" && body.text.length <= 4000) return xdotool(desktop, ["type", "--delay", "20", "--", body.text]);
  if (body.action === "key" && typeof body.keys === "string" && /^[\w+ -]{1,100}$/.test(body.keys)) return xdotool(desktop, ["key", "--", ...body.keys.split(" ")]);
  if (body.action === "open" && typeof body.url === "string" && /^https?:\/\/\S{1,2000}$/.test(body.url)) {
    await xdotool(desktop, ["search", "--sync", "--onlyvisible", "--class", "chromium", "windowactivate", "--sync"]);
    return (await xdotool(desktop, ["key", "ctrl+l"])) && (await xdotool(desktop, ["type", "--delay", "10", "--", body.url])) && xdotool(desktop, ["key", "Return"]);
  }
  return false;
}

const PACK_EXCLUDES = ["--exclude=Cache", "--exclude=Code Cache", "--exclude=GPUCache", "--exclude=GrShaderCache", "--exclude=ShaderCache", "--exclude=Singleton*", "--exclude=*.tmp"];
const run = (command, args) => new Promise((resolve) => execFile(command, args, { timeout: 300_000, maxBuffer: 1024 * 1024 }, (error) => resolve(!error)));
const fileSha256 = async (file) => { const hash = createHash("sha256"); await pipeline(createReadStream(file), hash); return hash.digest("hex"); };

async function pack(dog) {
  if (!existsSync(join(PROFILES, dog))) return null;
  const file = join(tmpdir(), `box-pack-${dog}-${Date.now()}.tgz`);
  if (!(await run("tar", ["-czf", file, ...PACK_EXCLUDES, "-C", PROFILES, dog]))) { rmSync(file, { force: true }); return null; }
  return { file, bytes: statSync(file).size, sha256: await fileSha256(file) };
}

async function unpack(dog, req, expected) {
  const file = join(tmpdir(), `box-unpack-${dog}-${Date.now()}.tgz`);
  try {
    await pipeline(req, createWriteStream(file));
    if (await fileSha256(file) !== expected) return "checksum";
    const staging = join(PROFILES, `.incoming-${dog}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    if (!(await run("tar", ["-xzf", file, "-C", staging]))) return "unreadable";
    if (!existsSync(join(staging, dog))) return "unreadable";
    rmSync(join(PROFILES, dog), { recursive: true, force: true });
    await run("mv", [join(staging, dog), join(PROFILES, dog)]);
    rmSync(staging, { recursive: true, force: true });
    await run("chown", ["-R", "dog:dog", join(PROFILES, dog)]);
    return "ok";
  } finally { rmSync(file, { force: true }); }
}

function profiles() {
  if (!existsSync(PROFILES)) return [];
  return readdirSync(PROFILES).filter((name) => DOG.test(name)).map((dog) => ({ dog, open: desktops.has(dog), changedAt: statSync(join(PROFILES, dog)).mtimeMs }));
}

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://box");
  const match = /^\/desktops\/([^/]+)(\/screenshot|\/touch|\/input)?$/.exec(url.pathname);
  try {
    const profile = /^\/profiles\/([^/]+)$/.exec(url.pathname);
    if (url.pathname === "/profiles" && req.method === "GET") return send(res, 200, { profiles: profiles() });
    if (profile && DOG.test(profile[1])) {
      const dog = profile[1];
      if (req.method === "GET") {
        const packed = await pack(dog);
        if (!packed) return send(res, 404, { error: { code: "no_profile", message: "This dog has no profile on the box." } });
        res.writeHead(200, { "content-type": "application/gzip", "content-length": String(packed.bytes), "x-laterdog-sha256": packed.sha256 });
        await pipeline(createReadStream(packed.file), res).finally(() => rmSync(packed.file, { force: true }));
        return;
      }
      if (req.method === "PUT") {
        if (desktops.has(dog)) return send(res, 409, { error: { code: "desktop_open", message: "Close the dog's desktop before restoring its profile." } });
        const expected = String(req.headers["x-laterdog-sha256"] ?? "");
        if (!/^[0-9a-f]{64}$/.test(expected)) return send(res, 400, { error: { code: "no_checksum", message: "Send the package's sha256." } });
        const outcome = await unpack(dog, req, expected);
        return outcome === "ok" ? send(res, 200, { restored: dog }) : send(res, 422, { error: { code: outcome, message: `The profile package was refused (${outcome}).` } });
      }
    }
    if (url.pathname === "/status" && req.method === "GET") {
      return send(res, 200, { box: { uptimeMs: Date.now() - started, maxDesktops: MAX_DESKTOPS, idleMs: IDLE_MS, memory: memory() }, desktops: [...desktops].map(([dog, desktop]) => view(dog, desktop)) });
    }
    if (!match || !DOG.test(match[1])) return send(res, 404, { error: { code: "not_found", message: "No such box route." } });
    const dog = match[1];
    if (!match[2] && req.method === "POST") {
      const opened = await open(dog);
      return opened ? send(res, 200, { desktop: opened }) : send(res, 429, { error: { code: "box_full", message: `The box already shows ${MAX_DESKTOPS} desktops.` } });
    }
    if (!match[2] && req.method === "DELETE") return send(res, 200, { closed: await close(dog) });
    const desktop = desktops.get(dog);
    if (!desktop) return send(res, 404, { error: { code: "no_desktop", message: "This dog has no desktop open." } });
    desktop.usedAt = Date.now();
    if (match[2] === "/touch" && req.method === "POST") return send(res, 200, { desktop: view(dog, desktop) });
    if (match[2] === "/input" && req.method === "POST") {
      const done = await input(desktop, await readBody(req));
      return done ? send(res, 200, { done: true }) : send(res, 400, { error: { code: "bad_input", message: "Send click with x and y, type with text, key with keys, or open with an http(s) url." } });
    }
    if (match[2] === "/screenshot" && req.method === "GET") {
      const png = await screenshot(desktop);
      if (!png) return send(res, 503, { error: { code: "no_screenshot", message: "The desktop could not be captured." } });
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png);
    }
    return send(res, 405, { error: { code: "method", message: "Method not allowed." } });
  } catch (error) {
    return send(res, 500, { error: { code: "box_error", message: error instanceof Error ? error.message : String(error) } });
  }
}).listen(PORT, "0.0.0.0");

process.on("SIGTERM", async () => { await Promise.all([...desktops.keys()].map((dog) => close(dog))); process.exit(0); });
