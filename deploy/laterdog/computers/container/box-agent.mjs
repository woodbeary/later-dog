import { spawn, execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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
  if (!up) { close(dog); throw new Error("display did not start"); }
  launch(desktop, ["x11vnc", "-display", `:${display}`, "-forever", "-shared", "-nopw", "-localhost", "-rfbport", String(desktop.vncPort), "-xkb", "-noxdamage", "-quiet"]);
  launch(desktop, ["laterdog-websockify", `0.0.0.0:${desktop.wsPort}`, `localhost:${desktop.vncPort}`]);
  launch(desktop, asDog(display, ["xfwm4"]));
  launch(desktop, asDog(display, ["chromium", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--disable-dev-shm-usage", "--hide-crash-restore-bubble", "--start-maximized"]));
  return view(dog, desktop);
}

function close(dog) {
  const desktop = desktops.get(dog);
  if (!desktop) return false;
  desktops.delete(dog);
  for (const child of desktop.children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
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
  for (const [dog, desktop] of desktops) if (Date.now() - desktop.usedAt > IDLE_MS) close(dog);
}, 60_000).unref();

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://box");
  const match = /^\/desktops\/([^/]+)(\/screenshot|\/touch)?$/.exec(url.pathname);
  try {
    if (url.pathname === "/status" && req.method === "GET") {
      return send(res, 200, { box: { uptimeMs: Date.now() - started, maxDesktops: MAX_DESKTOPS, idleMs: IDLE_MS, memory: memory() }, desktops: [...desktops].map(([dog, desktop]) => view(dog, desktop)) });
    }
    if (!match || !DOG.test(match[1])) return send(res, 404, { error: { code: "not_found", message: "No such box route." } });
    const dog = match[1];
    if (!match[2] && req.method === "POST") {
      const opened = await open(dog);
      return opened ? send(res, 200, { desktop: opened }) : send(res, 429, { error: { code: "box_full", message: `The box already shows ${MAX_DESKTOPS} desktops.` } });
    }
    if (!match[2] && req.method === "DELETE") return send(res, 200, { closed: close(dog) });
    const desktop = desktops.get(dog);
    if (!desktop) return send(res, 404, { error: { code: "no_desktop", message: "This dog has no desktop open." } });
    desktop.usedAt = Date.now();
    if (match[2] === "/touch" && req.method === "POST") return send(res, 200, { desktop: view(dog, desktop) });
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

process.on("SIGTERM", () => { for (const dog of [...desktops.keys()]) close(dog); process.exit(0); });
