import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const HOLDER = join(HERE, "../shell/hold-fixture.ts");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function named(words) {
  const script = words.slice(1).find((word) => !word.startsWith("-"));
  return [basename(words[0] ?? "?"), script ? basename(script) : ""].join(" ").trim();
}

function descendants(rootPid) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/));
  const children = new Map();
  const names = new Map();
  for (const [pid, parent, ...words] of rows) {
    names.set(Number(pid), named(words));
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

function megabytes(kilobytes) {
  return Math.round(kilobytes / 102.4) / 10;
}

function memoryKb(pid) {
  if (process.platform !== "linux") return { pss: 0, rss: Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) };
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  return { pss: field(rollup, "Pss"), rss: field(rollup, "Rss") };
}

function treeMemory(rootPid) {
  let pss = 0;
  let rss = 0;
  const each = [];
  for (const { pid, name } of descendants(rootPid)) {
    try {
      const own = memoryKb(pid);
      pss += own.pss;
      rss += own.rss;
      each.push({ pid, name, pssMb: megabytes(own.pss), rssMb: megabytes(own.rss) });
    } catch {}
  }
  return { processes: each.length, pssMb: megabytes(pss), rssMb: megabytes(rss), each };
}

function serverPeakRssMb(pid) {
  return process.platform === "linux" ? megabytes(field(readFileSync(`/proc/${pid}/status`, "utf8"), "VmHWM")) : 0;
}

function held(dist, extra, onStart) {
  const holder = spawn(process.execPath, ["--experimental-strip-types", HOLDER, "--dist", dist, ...extra], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  onStart?.(holder);
  const ready = new Promise((done, failed) => {
    createInterface({ input: holder.stdout }).on("line", (line) => {
      if (line.startsWith("{")) done(JSON.parse(line));
    });
    holder.on("exit", (code) => failed(new Error(`fixture exited ${code}`)));
  });
  const close = () =>
    new Promise((done) => {
      holder.once("exit", done);
      holder.kill("SIGTERM");
    });
  return { ready, close };
}

function busiestTree(holder) {
  let most = { pssMb: 0, rssMb: 0, processes: 0 };
  const timer = setInterval(() => {
    const server = descendants(holder.pid).find(({ pid, name }) => pid !== holder.pid && !name.startsWith("ps"));
    if (!server) return;
    const now = treeMemory(server.pid);
    if (now.rssMb > most.rssMb) most = now;
  }, 250);
  return () => {
    clearInterval(timer);
    return most;
  };
}

async function bareNodeIdle() {
  const bare = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await pause(2_000);
  const idle = treeMemory(bare.pid);
  bare.kill("SIGTERM");
  return idle;
}

const alone = (tree, pid) => tree.each.find((process) => process.pid === pid) ?? { pssMb: 0, rssMb: 0 };

async function oneRun(dist, turns, dogs, dogTurns, opens) {
  const bare = await bareNodeIdle();
  const fresh = held(dist, ["--long-turns", "0", "--other-dogs", "0"]);
  const empty = await fresh.ready;
  await pause(5_000);
  const freshIdle = treeMemory(empty.serverPid);
  const freshPeakRssMb = serverPeakRssMb(empty.serverPid);
  await fresh.close();
  let busiest;
  const started = performance.now();
  const used = held(dist, ["--long-turns", String(turns), "--other-dogs", String(dogs), "--other-turns", String(dogTurns), "--time-opens", String(opens)], (holder) => {
    busiest = busiestTree(holder);
  });
  const filled = await used.ready;
  const fillMs = performance.now() - started;
  const whileAnswering = busiest();
  await pause(5_000);
  const usedIdle = treeMemory(filled.serverPid);
  const usedPeakRssMb = serverPeakRssMb(filled.serverPid);
  const databaseBytes = statSync(join(filled.dataDir, "messages.db")).size;
  await used.close();
  const others = usedIdle.each.filter((process) => process.pid !== filled.serverPid).map(({ name, pssMb, rssMb }) => ({ name, pssMb, rssMb }));
  return { bare, freshIdle, freshPeakRssMb, whileAnswering, usedIdle, usedServer: alone(usedIdle, filled.serverPid), others, usedPeakRssMb, fillMs, databaseBytes, opens: filled.opens };
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const round = (value) => Math.round(value * 10) / 10;
  return { median: round(sorted[Math.floor(sorted.length / 2)]), min: round(sorted[0]), max: round(sorted.at(-1)) };
}

const dist = resolve(option("dist", join(ROOT, "dist")));
const runs = Number(option("runs", "5"));
const turns = Number(option("long-turns", "120"));
const dogs = Number(option("other-dogs", "5"));
const dogTurns = Number(option("other-turns", "6"));
const opens = Number(option("opens", "40"));
const results = [];
for (let run = 0; run < runs; run += 1) results.push(await oneRun(dist, turns, dogs, dogTurns, opens));
const each = (pick) => summary(results.map(pick));
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const report = {
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  runs,
  fixture: { longChatMessages: turns * 2, otherDogs: dogs, otherDogMessages: dogTurns * 2, engine: "the repository's fake engine" },
  bareNodeIdle: { pssMb: each((result) => result.bare.pssMb), rssMb: each((result) => result.bare.rssMb) },
  freshServerIdle: { pssMb: each((result) => result.freshIdle.pssMb), rssMb: each((result) => result.freshIdle.rssMb), serverPeakRssMb: each((result) => result.freshPeakRssMb), processes: results[0].freshIdle.processes },
  whileDogsAnswer: { treeRssMb: each((result) => result.whileAnswering.rssMb), treePssMb: each((result) => result.whileAnswering.pssMb), mostProcesses: Math.max(...results.map((result) => result.whileAnswering.processes)) },
  afterTheChatsIdle: { pssMb: each((result) => result.usedIdle.pssMb), rssMb: each((result) => result.usedIdle.rssMb), serverAlonePssMb: each((result) => result.usedServer.pssMb), serverAloneRssMb: each((result) => result.usedServer.rssMb), serverPeakRssMb: each((result) => result.usedPeakRssMb), processes: results[0].usedIdle.processes, otherProcessesInTheFirstRun: results[0].others },
  fillSeconds: each((result) => result.fillMs / 1000),
  databaseKb: Math.round(results[0].databaseBytes / 1024),
  openLongChatOverHttp: { opensEachRun: opens, newest50Ms: each((result) => median(result.opens.newest50Ms)), newest50FirstMs: each((result) => result.opens.newest50Ms[0]), wholeChatMs: each((result) => median(result.opens.wholeChatMs)) },
};
const out = option("out");
if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
