import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createHttpStore, scan, snapshot } from "../../../deploy/laterdog/home/runtime/sync.mjs";
import { scanInWorker, scanSync, scanTogether } from "./walk-variants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BINARY = process.env.SAVE_WALK_BINARY ?? join(HERE, "target/release/save-walk");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function memoryStore(known = new Set()) {
  const counts = { has: 0, put: 0, putBytes: 0 };
  return {
    counts,
    async has(hash) {
      counts.has += 1;
      return known.has(hash);
    },
    async put(hash, bytes) {
      counts.put += 1;
      counts.putBytes += bytes.length;
      known.add(hash);
    },
    async putManifest() {},
  };
}

function knownChunks(previous) {
  return new Set(previous.entries.flatMap((entry) => entry.chunks ?? []));
}

function blobServer(known, delayMs) {
  const counts = { has: 0, put: 0, putBytes: 0 };
  const server = createServer((request, response) => {
    const hash = request.url.split("/").at(-1);
    const answer = (status) => setTimeout(() => response.writeHead(status).end(), delayMs);
    if (request.method === "HEAD") {
      counts.has += 1;
      answer(known.has(hash) ? 200 : 404);
      return;
    }
    let bytes = 0;
    request.on("data", (piece) => {
      bytes += piece.length;
    });
    request.on("end", () => {
      if (request.url.includes("/blobs/")) {
        counts.put += 1;
        counts.putBytes += bytes;
        known.add(hash);
      }
      answer(200);
    });
  });
  return new Promise((ready) => server.listen(0, "127.0.0.1", () => ready({ server, counts, url: `http://127.0.0.1:${server.address().port}` })));
}

function peakRssMb() {
  const kilobytes = Number(readFileSync("/proc/self/status", "utf8").match(/^VmHWM:\s+(\d+) kB/m)?.[1] ?? 0);
  return Math.round(kilobytes / 102.4) / 10;
}

function longestStallMs() {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - 5);
    last = now;
  }, 5);
  return () => {
    clearInterval(timer);
    return Math.max(longest, performance.now() - last - 5);
  };
}

function rustWalk(root) {
  const answer = execFileSync(BINARY, ["scan-json", root], { maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(answer.toString("utf8"));
}

const WALKS = {
  "node-scan": scan,
  "node-scan-together": scanTogether,
  "node-scan-sync": async (root) => scanSync(root),
  "node-scan-worker": scanInWorker,
  "rust-scan-from-node": async (root) => rustWalk(root),
};

async function child(mode, root, previousPath) {
  const started = performance.now();
  if (mode in WALKS) {
    const stalled = longestStallMs();
    const entries = await WALKS[mode](root);
    const totalMs = performance.now() - started;
    const stallMs = stalled();
    const peak = peakRssMb();
    const same = process.argv.includes("--check") ? isDeepStrictEqual(entries, await scan(root)) : undefined;
    return { mode, entries: entries.length, totalMs, stallMs, same, peakRssMb: peak };
  }
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  const scratch = mode.includes("copy") ? join(dirname(previousPath), `scratch-${process.pid}`) : undefined;
  const delayMs = Number(option("delay-ms", "0"));
  const remote = mode.includes("http") ? await blobServer(knownChunks(previous), delayMs) : null;
  const store = remote ? createHttpStore(remote.url, "bench") : memoryStore(knownChunks(previous));
  const result = await snapshot(root, store, previous, scratch ? { scratch } : {});
  const totalMs = performance.now() - started;
  remote?.server.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  const counts = remote ? remote.counts : store.counts;
  return { mode, entries: result.manifest.entries.length, changed: result.uploaded, unsaved: result.unsaved.length, ...counts, delayMs, totalMs, peakRssMb: peakRssMb() };
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const round = (value) => Math.round(value * 10) / 10;
  return { median: round(sorted[Math.floor(sorted.length / 2)]), min: round(sorted[0]), max: round(sorted.at(-1)) };
}

function runOnce(command, args) {
  return new Promise((done, failed) => {
    const worker = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    worker.stdout.on("data", (piece) => {
      output += piece;
    });
    worker.on("exit", (code) => (code === 0 ? done(JSON.parse(output.trim().split("\n").at(-1))) : failed(new Error(`${command} ${args.join(" ")} exited ${code}`))));
  });
}

async function measure(label, runs, command, args) {
  const results = [];
  for (let run = 0; run < runs; run += 1) results.push(await runOnce(command, args));
  const first = results[0];
  const phases = Object.fromEntries(["scanMs", "compareMs", "hashMs", "stallMs"].filter((key) => key in first).map((key) => [key, summary(results.map((result) => result[key]))]));
  return {
    label,
    runs,
    entries: first.entries,
    same: first.same,
    changed: first.changed,
    chunks: first.chunks,
    has: first.has,
    put: first.put,
    putMb: first.putBytes === undefined ? undefined : Math.round(first.putBytes / 1048576),
    wallMs: summary(results.map((result) => result.totalMs)),
    ...phases,
    peakRssMb: summary(results.map((result) => result.peakRssMb)),
  };
}

async function orchestrate() {
  const root = resolve(option("root"));
  const work = resolve(option("work", join(dirname(root), "save-bench-work")));
  const runs = Number(option("runs", "7"));
  mkdirSync(work, { recursive: true });
  const previousPath = join(work, "previous.json");
  if (!process.argv.includes("--keep-previous") && !process.argv.includes("--walk-only")) {
    const first = await snapshot(root, memoryStore(), null, {});
    writeFileSync(previousPath, JSON.stringify(first.manifest));
    execFileSync(process.execPath, [join(HERE, "make-home.mjs"), "change", root, "--files", option("files", "20000"), "--changes", option("changes", "300")], { stdio: "inherit" });
  }
  const self = fileURLToPath(import.meta.url);
  const node = (mode, extra = []) => [self, "child", mode, root, previousPath, ...extra];
  const walks = [
    await measure("Node today: walk, one lstat at a time", runs, process.execPath, node("node-scan")),
    await measure("Node: walk, a folder's lstats together", runs, process.execPath, node("node-scan-together", ["--check"])),
    await measure("Node: walk with synchronous calls", runs, process.execPath, node("node-scan-sync", ["--check"])),
    await measure("Node: the synchronous walk in a worker thread", runs, process.execPath, node("node-scan-worker", ["--check"])),
    await measure("Rust: walk only, inside the binary", runs, BINARY, ["scan", root]),
    await measure("Rust: walk called from Node, entries parsed", runs, process.execPath, node("rust-scan-from-node", ["--check"])),
  ];
  if (process.argv.includes("--walk-only")) return finish(root, work, runs, walks);
  const rows = [
    ...walks,
    await measure("Node: walk, compare, hash changed files", runs, process.execPath, node("node-save")),
    await measure("Rust, 1 thread: walk, compare, hash changed files", runs, BINARY, ["save", root, previousPath, "1"]),
    await measure("Rust, 4 threads: walk, compare, hash changed files", runs, BINARY, ["save", root, previousPath, "4"]),
    await measure("Node: the same plus the database copy", runs, process.execPath, node("node-save-copy")),
    await measure("Node: the same plus the copy, blob checks over local HTTP", runs, process.execPath, node("node-save-copy-http")),
    await measure("Node: the same, each blob request answered after 30 ms", Math.min(runs, 3), process.execPath, node("node-save-copy-http", ["--delay-ms", "30"])),
  ];
  finish(root, work, runs, rows);
}

function finish(root, work, runs, rows) {
  const report = { platform: `${process.platform} ${process.arch}`, node: process.version, root, runs, rows };
  const out = resolve(option("out", join(work, "save.json")));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[2] === "child") {
  process.stdout.write(`${JSON.stringify(await child(process.argv[3], process.argv[4], process.argv[5]))}\n`);
} else {
  await orchestrate();
}
