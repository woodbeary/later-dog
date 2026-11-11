import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PROBE = join(HERE, "page-probe.js");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : process.argv[index + 1];
  if (value === undefined) throw new Error(`bench-shell needs --${name}`);
  return value;
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function descendants(rootPid) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/));
  const children = new Map();
  const names = new Map();
  for (const [pid, parent, name] of rows) {
    names.set(Number(pid), name);
    children.set(Number(parent), [...(children.get(Number(parent)) ?? []), Number(pid)]);
  }
  const found = [];
  const walk = (pid) => {
    found.push({ pid, name: names.get(pid) ?? "?" });
    for (const child of children.get(pid) ?? []) walk(child);
  };
  walk(rootPid);
  return found;
}

function field(text, name) {
  const match = text.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"));
  return match ? Number(match[1]) : 0;
}

function memoryKb(pid) {
  if (process.platform !== "linux") return { pss: 0, rss: Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) };
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  return { pss: field(rollup, "Pss"), rss: field(rollup, "Rss") };
}

function treeMemory(rootPid) {
  let pss = 0;
  let rss = 0;
  const processes = [];
  for (const { pid, name } of descendants(rootPid)) {
    let kilobytes;
    try {
      kilobytes = memoryKb(pid);
    } catch {
      continue;
    }
    const own = { name, pssMb: Math.round(kilobytes.pss / 1024), rssMb: Math.round(kilobytes.rss / 1024) };
    if (own.rssMb === 0) continue;
    processes.push(own);
    pss += kilobytes.pss;
    rss += kilobytes.rss;
  }
  return { processes: processes.length, pssMb: Math.round(pss / 1024), rssMb: Math.round(rss / 1024), byProcess: processes };
}

function lines(stream, onLine) {
  createInterface({ input: stream }).on("line", onLine);
}

function nextEvent(shell, name, timeoutMs = 90_000) {
  return new Promise((done, failed) => {
    const timer = setTimeout(() => failed(new Error(`${shell.label}: no ${name} event in ${timeoutMs} ms`)), timeoutMs);
    shell.waiting.push({ name, done: (event) => { clearTimeout(timer); done(event); } });
  });
}

function launch(label, command, args, env) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const shell = { label, child, waiting: [], startedAt: performance.now() };
  lines(child.stdout, (line) => {
    if (!line.startsWith("SHELL ")) return;
    const event = JSON.parse(line.slice(6));
    const index = shell.waiting.findIndex((waiter) => waiter.name === event.event);
    if (index !== -1) shell.waiting.splice(index, 1)[0].done({ ...event, wallMs: performance.now() - shell.startedAt });
  });
  lines(child.stderr, (line) => {
    if (process.argv.includes("--verbose")) process.stderr.write(`[${label}] ${line}\n`);
  });
  return shell;
}

function stop(shell) {
  try {
    process.kill(-shell.child.pid, "SIGKILL");
  } catch {
    shell.child.kill("SIGKILL");
  }
}

async function oneRun(label, command, args, env, fixture) {
  const shell = launch(label, command, args, env);
  try {
    const ready = await nextEvent(shell, "ready");
    await pause(5_000);
    const idle = treeMemory(shell.child.pid);
    const open = async (dog) => {
      const opened = nextEvent(shell, "opened");
      shell.child.stdin.write(`window.__openChat(${JSON.stringify(dog.id)}, ${JSON.stringify(dog.name)})\n`);
      return opened;
    };
    await open(fixture.short);
    await pause(500);
    const first = await open(fixture.long);
    await pause(500);
    await open(fixture.short);
    await pause(500);
    const second = await open(fixture.long);
    await pause(3_000);
    const afterLongChat = treeMemory(shell.child.pid);
    return { wallToComposerMs: ready.wallMs, pageToComposerMs: ready.composerAt, firstPaintMs: ready.firstPaint, engine: ready.engine, openLongFirstMs: first.ms, openLongAgainMs: second.ms, rowsShown: second.rows, idle, afterLongChat };
  } finally {
    stop(shell);
    await pause(500);
  }
}

function summary(values) {
  const present = values.filter((value) => typeof value === "number").sort((left, right) => left - right);
  if (present.length === 0) return null;
  return { median: Math.round(present[Math.floor(present.length / 2)]), min: Math.round(present[0]), max: Math.round(present.at(-1)) };
}

function folderBytes(path) {
  if (process.platform === "linux") return Number(execFileSync("du", ["-sb", path], { encoding: "utf8" }).split(/\s+/)[0]);
  return Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split(/\s+/)[0]) * 1024;
}

async function holdFixture(dist) {
  const holder = spawn(process.execPath, ["--experimental-strip-types", join(HERE, "hold-fixture.ts"), "--dist", dist], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  const fixture = await new Promise((done, failed) => {
    lines(holder.stdout, (line) => {
      if (line.startsWith("{")) done(JSON.parse(line));
    });
    holder.on("exit", (code) => failed(new Error(`fixture exited ${code}`)));
  });
  return { ...fixture, holder };
}

async function main() {
  const electron = resolve(option("electron"));
  const wry = resolve(option("wry"));
  const runs = Number(option("runs", "5"));
  const fixture = await holdFixture(resolve(option("dist", join(ROOT, "dist"))));
  const shells = [
    {
      label: "Electron",
      binaryBytes: folderBytes(resolve(option("electron-folder", dirname(electron)))),
      start: (profile) => [electron, [join(HERE, "electron-shell.mjs"), "--no-sandbox", `--user-data-dir=${profile}`, fixture.url, PROBE], { ...process.env }],
    },
    {
      label: process.platform === "linux" ? "Rust shell on WebKitGTK" : "Rust shell on the system webview",
      binaryBytes: statSync(wry).size,
      start: (profile) => [wry, [fixture.url, PROBE], { ...process.env, XDG_DATA_HOME: join(profile, "data"), XDG_CACHE_HOME: join(profile, "cache"), WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1" }],
    },
  ];
  const report = { platform: `${process.platform} ${process.arch}`, at: new Date().toISOString(), runs, fixture: { url: fixture.url, long: fixture.long.name, short: fixture.short.name }, shells: [] };
  try {
    for (const shell of shells) {
      const results = [];
      for (let run = 0; run < runs; run += 1) {
        const profile = mkdtempSync(join(tmpdir(), "shell-profile-"));
        const [command, args, env] = shell.start(profile);
        try {
          results.push(await oneRun(shell.label, command, args, env, fixture));
        } finally {
          rmSync(profile, { recursive: true, force: true });
        }
      }
      report.shells.push({
        label: shell.label,
        engine: results[0].engine,
        binaryMb: Math.round(shell.binaryBytes / 104857.6) / 10,
        wallToComposerMs: summary(results.map((result) => result.wallToComposerMs)),
        pageToComposerMs: summary(results.map((result) => result.pageToComposerMs)),
        firstPaintMs: summary(results.map((result) => result.firstPaintMs)),
        openLongFirstMs: summary(results.map((result) => result.openLongFirstMs)),
        openLongAgainMs: summary(results.map((result) => result.openLongAgainMs)),
        rowsShown: results[0].rowsShown,
        idlePssMb: summary(results.map((result) => result.idle.pssMb)),
        idleRssMb: summary(results.map((result) => result.idle.rssMb)),
        afterLongChatPssMb: summary(results.map((result) => result.afterLongChat.pssMb)),
        afterLongChatRssMb: summary(results.map((result) => result.afterLongChat.rssMb)),
        processes: results[0].afterLongChat.byProcess,
      });
    }
  } finally {
    fixture.holder.kill("SIGTERM");
  }
  const out = resolve(option("out", join(tmpdir(), "shell.json")));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
