import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createHttpStore, scan, snapshot } from "../../../deploy/laterdog/home/runtime/sync.mjs";
import { scanAcross, scanInBatches, scanInWorker, scanOneAtATime, scanSync, scanTogether } from "./walk-variants.mjs";

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
  const kilobytes = process.platform === "linux" ? Number(readFileSync("/proc/self/status", "utf8").match(/^VmHWM:\s+(\d+) kB/m)?.[1] ?? 0) : process.resourceUsage().maxRSS;
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

function rustChild(args) {
  return new Promise((done, failed) => {
    const worker = spawn(BINARY, args, { stdio: ["ignore", "pipe", "inherit"] });
    const pieces = [];
    worker.stdout.on("data", (piece) => pieces.push(piece));
    worker.on("error", failed);
    worker.on("close", (code) => (code === 0 ? done(Buffer.concat(pieces)) : failed(new Error(`save-walk ${args[0]} exited ${code}`))));
  });
}

async function rustWalkChild(root) {
  return JSON.parse((await rustChild(["scan-json", root])).toString("utf8"));
}

function firstDifference(left, right) {
  if (left.length !== right.length) return `${left.length} entries against ${right.length}`;
  const index = left.findIndex((entry, at) => !isDeepStrictEqual(entry, right[at]));
  return index === -1 ? null : `entry ${index}: ${JSON.stringify(left[index])} against ${JSON.stringify(right[index])}`;
}

async function sameAsNodeSave(entries, root, previous) {
  const reference = await snapshot(root, memoryStore(knownChunks(previous)), previous, {});
  const difference = firstDifference(entries, reference.manifest.entries);
  if (difference) process.stderr.write(`differs from the Node save: ${difference}\n`);
  return difference === null;
}

const WALKS = {
  "node-scan-one-at-a-time": scanOneAtATime,
  "node-scan": scan,
  "node-scan-batches": (root) => scanInBatches(root, Number(option("width"))),
  "node-scan-across": (root) => scanAcross(root, Number(option("width"))),
  "node-scan-together": scanTogether,
  "node-scan-sync": async (root) => scanSync(root),
  "node-scan-worker": scanInWorker,
  "rust-scan-from-node": async (root) => rustWalk(root),
  "rust-scan-child": rustWalkChild,
};

async function child(mode, root, previousPath) {
  const started = performance.now();
  if (mode in WALKS) {
    const stalled = longestStallMs();
    const entries = await WALKS[mode](root);
    const totalMs = performance.now() - started;
    const stallMs = stalled();
    const peak = peakRssMb();
    const same = process.argv.includes("--check") ? isDeepStrictEqual(entries, await scanOneAtATime(root)) : undefined;
    return { mode, entries: entries.length, totalMs, stallMs, same, peakRssMb: peak };
  }
  const checking = process.argv.includes("--check");
  if (mode === "rust-save-child") {
    const stalled = longestStallMs();
    const answered = await rustChild(["save-json", root, previousPath, option("threads", "1")]);
    const parsing = performance.now();
    const saved = JSON.parse(answered.toString("utf8"));
    const parseMs = performance.now() - parsing;
    const totalMs = performance.now() - started;
    const stallMs = stalled();
    const peak = peakRssMb();
    const same = checking ? await sameAsNodeSave(saved.entries, root, JSON.parse(readFileSync(previousPath, "utf8"))) : undefined;
    const { scanMs, compareMs, hashMs, changed, chunks, peakRssMb: childPeakRssMb } = saved.report;
    return { mode, entries: saved.entries.length, changed, chunks, same, answerMb: Math.round(answered.length / 104857.6) / 10, scanMs, compareMs, hashMs, parseMs, totalMs, stallMs, peakRssMb: peak, childPeakRssMb };
  }
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  const save = mode === "node-save-from" ? (await import(pathToFileURL(resolve(option("sync"))).href)).snapshot : snapshot;
  const scratch = mode.includes("copy") ? join(dirname(previousPath), `scratch-${process.pid}`) : undefined;
  const delayMs = Number(option("delay-ms", "0"));
  const remote = mode.includes("http") ? await blobServer(knownChunks(previous), delayMs) : null;
  const store = remote ? createHttpStore(remote.url, "bench") : memoryStore(knownChunks(previous));
  const saving = performance.now();
  const stalled = longestStallMs();
  const result = await save(root, store, previous, scratch ? { scratch } : {});
  const totalMs = performance.now() - saving;
  const stallMs = stalled();
  const peak = peakRssMb();
  remote?.server.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  const counts = remote ? remote.counts : store.counts;
  const same = checking ? await sameAsNodeSave(result.manifest.entries, root, previous) : undefined;
  return { mode, entries: result.manifest.entries.length, changed: result.uploaded, unsaved: result.unsaved.length, same, ...counts, delayMs, totalMs, stallMs, peakRssMb: peak };
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

function row(label, results) {
  const first = results[0];
  const phases = Object.fromEntries(["scanMs", "compareMs", "hashMs", "parseMs", "stallMs", "childPeakRssMb"].filter((key) => key in first).map((key) => [key, summary(results.map((result) => result[key]))]));
  return {
    label,
    runs: results.length,
    entries: first.entries,
    same: first.same,
    changed: first.changed,
    chunks: first.chunks,
    has: first.has,
    put: first.put,
    putMb: first.putBytes === undefined ? undefined : Math.round(first.putBytes / 1048576),
    answerMb: first.answerMb,
    wallMs: summary(results.map((result) => result.totalMs)),
    ...phases,
    peakRssMb: summary(results.map((result) => result.peakRssMb)),
    wallMsEachRun: results.map((result) => Math.round(result.totalMs * 10) / 10),
  };
}

const checkedOnce = (run, args) => (run === 0 ? args : args.filter((argument) => argument !== "--check"));

async function measure(label, runs, command, args) {
  const results = [];
  for (let run = 0; run < runs; run += 1) results.push(await runOnce(command, checkedOnce(run, args)));
  return row(label, results);
}

async function measuredTakingTurns(runs, variants) {
  const results = variants.map(() => []);
  for (let run = 0; run < runs; run += 1) {
    for (const [index, [, command, args]] of variants.entries()) results[index].push(await runOnce(command, checkedOnce(run, args)));
  }
  return variants.map(([label], index) => row(label, results[index]));
}

async function inTurn(steps) {
  const rows = [];
  for (const step of steps) rows.push(await step());
  return rows;
}

function exited(command, args) {
  return new Promise((done, failed) => {
    const worker = spawn(command, args, { stdio: "ignore" });
    worker.on("error", failed);
    worker.on("close", done);
  });
}

async function startCost(label, runs, command, args) {
  const took = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await exited(command, args);
    took.push(performance.now() - started);
  }
  return { label, runs, wallMs: summary(took) };
}

async function startCosts(runs) {
  const empty = mkdtempSync(join(tmpdir(), "save-walk-empty-"));
  try {
    return [
      await startCost("Starting any small program from Node and waiting for it to end (/bin/true)", runs, "/bin/true", []),
      await startCost("Starting the Rust binary from Node on an empty folder and waiting for it to end", runs, BINARY, ["scan", empty]),
    ];
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

async function orchestrate() {
  const root = resolve(option("root"));
  const work = resolve(option("work", join(dirname(root), "save-bench-work")));
  const runs = Number(option("runs", "7"));
  const tiny = process.argv.includes("--tiny");
  mkdirSync(work, { recursive: true });
  const previousPath = join(work, "previous.json");
  if (!process.argv.includes("--keep-previous") && !process.argv.includes("--walk-only")) {
    const first = await snapshot(root, memoryStore(), null, {});
    writeFileSync(previousPath, JSON.stringify(first.manifest));
    execFileSync(process.execPath, [join(HERE, "make-home.mjs"), tiny ? "change-tiny" : "change", root, "--files", option("files", tiny ? "140000" : "20000"), "--changes", option("changes", "300")], { stdio: "inherit" });
  }
  const self = fileURLToPath(import.meta.url);
  const node = (mode, extra = []) => [self, "child", mode, root, previousPath, ...extra];
  const widths = option("widths", "").split(",").filter(Boolean);
  const before = option("before-sync", "");
  const sized = option("sized-sync", "");
  const walks = process.argv.includes("--save-only")
    ? []
    : [
        await measure("Node before: walk, one lstat at a time", runs, process.execPath, node("node-scan-one-at-a-time")),
        await measure("Node now (sync.mjs): walk, a folder's lstats 32 at a time", runs, process.execPath, node("node-scan", ["--check"])),
        ...(await inTurn(widths.map((width) => () => measure(`Node: walk, a folder's lstats ${width} at a time`, runs, process.execPath, node("node-scan-batches", ["--width", width, "--check"]))))),
        ...(await inTurn(widths.map((width) => () => measure(`Node: walk, ${width} lstats at a time across folders`, runs, process.execPath, node("node-scan-across", ["--width", width, "--check"]))))),
        await measure("Node: walk, all of a folder's lstats together", runs, process.execPath, node("node-scan-together", ["--check"])),
        await measure("Node: walk with synchronous calls", runs, process.execPath, node("node-scan-sync", ["--check"])),
        await measure("Node: the synchronous walk in a worker thread", runs, process.execPath, node("node-scan-worker", ["--check"])),
        await measure("Rust: walk only, inside the binary", runs, BINARY, ["scan", root]),
        await measure("Rust: walk called from Node, entries parsed", runs, process.execPath, node("rust-scan-from-node", ["--check"])),
      ];
  if (process.argv.includes("--walk-only")) return finish(root, work, runs, walks);
  const saves = await measuredTakingTurns(runs, [
    ["Rust: walk in a child process started from Node, entries parsed", process.execPath, node("rust-scan-child", ["--check"])],
    ...(before ? [["Node before (one lstat at a time): walk, compare, hash changed files", process.execPath, node("node-save-from", ["--sync", before, "--check"])]] : []),
    ["Node now (a folder's lstats 32 at a time): walk, compare, hash changed files", process.execPath, node("node-save")],
    ...(sized ? [["Node now, reading each file into a buffer of its own size: walk, compare, hash changed files", process.execPath, node("node-save-from", ["--sync", sized, "--check"])]] : []),
    ["Rust, 1 thread: walk, compare, hash changed files", BINARY, ["save", root, previousPath, "1"]],
    ["Rust, 4 threads: walk, compare, hash changed files", BINARY, ["save", root, previousPath, "4"]],
    ["Rust, 1 thread, in a child process started from Node: walk, compare, hash, listing parsed", process.execPath, node("rust-save-child", ["--threads", "1", "--check"])],
    ["Rust, 4 threads, in a child process started from Node: walk, compare, hash, listing parsed", process.execPath, node("rust-save-child", ["--threads", "4", "--check"])],
  ]);
  const copies = process.argv.includes("--save-only")
    ? []
    : [
        await measure("Node: the same plus the database copy", runs, process.execPath, node("node-save-copy")),
        await measure("Node: the same plus the copy, blob checks over local HTTP", runs, process.execPath, node("node-save-copy-http")),
        await measure("Node: the same, each blob request answered after 30 ms", Math.min(runs, 3), process.execPath, node("node-save-copy-http", ["--delay-ms", "30"])),
      ];
  const rows = [...walks, ...saves, ...copies];
  finish(root, work, runs, rows, { binaryBytes: statSync(BINARY).size, starts: await startCosts(Number(option("start-runs", "50"))) });
}

function finish(root, work, runs, rows, binary) {
  const report = { platform: `${process.platform} ${process.arch}`, node: process.version, root, runs, rows, binary };
  const out = resolve(option("out", join(work, "save.json")));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[2] === "child") {
  process.stdout.write(`${JSON.stringify(await child(process.argv[3], process.argv[4], process.argv[5]))}\n`);
} else {
  await orchestrate();
}
