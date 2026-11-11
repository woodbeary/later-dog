import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const BINARY = process.env.CHAT_OPEN_BINARY ?? join(HERE, "target/release/chat-open");
const ALL_ROWS = "SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid";
const NEWEST_ROWS = "SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?";
const ACTIVE_LEAF = "SELECT active_leaf_id FROM thread_state WHERE thread_id = ?";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function peakRssMb() {
  const kilobytes = process.platform === "linux" ? Number(readFileSync("/proc/self/status", "utf8").match(/^VmHWM:\s+(\d+) kB/m)?.[1] ?? 0) : process.resourceUsage().maxRSS;
  return Math.round(kilobytes / 102.4) / 10;
}

function shaped(rows, limit, leaf) {
  if (limit === 0) return { messages: rows.map((row) => JSON.parse(row.json)), activeLeafId: leaf?.active_leaf_id ?? null, hasMore: false };
  const hasMore = rows.length > limit;
  if (hasMore) rows.length = limit;
  rows.reverse();
  return { messages: rows.map((row) => JSON.parse(row.json)), activeLeafId: leaf?.active_leaf_id ?? null, hasMore };
}

function nodeToday(database) {
  return (thread, limit) => {
    const rows = limit === 0 ? database.prepare(ALL_ROWS).all(thread) : database.prepare(NEWEST_ROWS).all(thread, limit + 1);
    return shaped(rows, limit, database.prepare(ACTIVE_LEAF).get(thread));
  };
}

function nodeKeptStatements(database) {
  const all = database.prepare(ALL_ROWS);
  const newest = database.prepare(NEWEST_ROWS);
  const leaf = database.prepare(ACTIVE_LEAF);
  return (thread, limit) => shaped(limit === 0 ? all.all(thread) : newest.all(thread, limit + 1), limit, leaf.get(thread));
}

function rustEachTime(file) {
  return (thread, limit) =>
    new Promise((done, failed) => {
      execFile(BINARY, ["once", file, thread, String(limit)], { maxBuffer: 256 * 1024 * 1024 }, (error, answer) => (error ? failed(error) : done(JSON.parse(answer))));
    });
}

function rustKeptRunning(file) {
  const helper = spawn(BINARY, ["serve", file], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = [];
  createInterface({ input: helper.stdout }).on("line", (line) => waiting.shift()(JSON.parse(line)));
  const asked = (line) =>
    new Promise((done) => {
      waiting.push(done);
      helper.stdin.write(`${line}\n`);
    });
  const open = (thread, limit) => asked(`${limit} ${thread}`);
  open.peakRssMb = async () => Math.round((await asked("peak")).peakRssKb / 102.4) / 10;
  open.close = () => helper.stdin.end();
  return open;
}

const VARIANTS = {
  "node-today": (file) => nodeToday(new DatabaseSync(file, { readOnly: true })),
  "node-kept-statements": (file) => nodeKeptStatements(new DatabaseSync(file, { readOnly: true })),
  "rust-each-time": rustEachTime,
  "rust-kept-running": rustKeptRunning,
};

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

async function child(variant, file, thread, limit, opens) {
  const started = performance.now();
  const open = VARIANTS[variant](file);
  const first = await open(thread, limit);
  const firstMs = performance.now() - started;
  const took = [];
  for (let pass = 0; pass < opens; pass += 1) {
    const at = performance.now();
    await open(thread, limit);
    took.push(performance.now() - at);
  }
  const same = process.argv.includes("--check") ? isDeepStrictEqual(first, nodeToday(new DatabaseSync(file, { readOnly: true }))(thread, limit)) : undefined;
  const helperPeakRssMb = open.peakRssMb ? await open.peakRssMb() : undefined;
  open.close?.();
  return { variant, rows: first.messages.length, hasMore: first.hasMore, answerKb: Math.round(JSON.stringify(first).length / 102.4) / 10, same, firstMs, openMs: median(took), slowestMs: Math.max(...took), peakRssMb: peakRssMb(), helperPeakRssMb };
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const round = (value) => Math.round(value * 1000) / 1000;
  return { median: round(sorted[Math.floor(sorted.length / 2)]), min: round(sorted[0]), max: round(sorted.at(-1)) };
}

function runOnce(args) {
  return new Promise((done, failed) => {
    execFile(process.execPath, args, { maxBuffer: 16 * 1024 * 1024 }, (error, output) => (error ? failed(error) : done(JSON.parse(output.trim().split("\n").at(-1)))));
  });
}

const LABELS = {
  "node-today": "Node today: the server's own database handle, statement prepared on every open",
  "node-kept-statements": "Node improved: the same handle with its three statements prepared once",
  "rust-each-time": "Rust: a child process started for every open, answer parsed in Node",
  "rust-kept-running": "Rust: one child process kept running, asked over a pipe, answer parsed in Node",
};

async function orchestrate() {
  const file = resolve(option("db"));
  const thread = option("thread", "marathon");
  const runs = Number(option("runs", "7"));
  const opens = option("opens", "200");
  const self = fileURLToPath(import.meta.url);
  const pages = option("pages", "50,0").split(",").map(Number);
  const rows = [];
  for (const limit of pages) {
    const results = Object.fromEntries(Object.keys(VARIANTS).map((variant) => [variant, []]));
    for (let run = 0; run < runs; run += 1) {
      for (const variant of Object.keys(VARIANTS)) {
        const eachTime = variant === "rust-each-time";
        results[variant].push(await runOnce([self, "child", variant, file, thread, String(limit), eachTime ? option("spawned-opens", "30") : opens, ...(run === 0 ? ["--check"] : [])]));
      }
    }
    for (const [variant, measured] of Object.entries(results)) {
      const helper = measured[0].helperPeakRssMb === undefined ? undefined : summary(measured.map((result) => result.helperPeakRssMb));
      const own = summary(measured.map((result) => result.peakRssMb));
      rows.push({
        label: LABELS[variant],
        page: limit === 0 ? "the whole chat" : `the newest ${limit} rows`,
        freshProcesses: measured.length,
        opensEach: variant === "rust-each-time" ? Number(option("spawned-opens", "30")) : Number(opens),
        rows: measured[0].rows,
        answerKb: measured[0].answerKb,
        same: measured[0].same,
        openMs: summary(measured.map((result) => result.openMs)),
        slowestOpenMs: summary(measured.map((result) => result.slowestMs)),
        firstOpenInAFreshProcessMs: summary(measured.map((result) => result.firstMs)),
        nodePeakRssMb: own,
        helperPeakRssMb: helper,
        treePeakRssMb: helper ? Math.round((own.median + helper.median) * 10) / 10 : own.median,
      });
    }
  }
  const report = { platform: `${process.platform} ${process.arch}`, node: process.version, databaseBytes: statSync(file).size, binaryBytes: statSync(BINARY).size, thread, runs, rows };
  const out = option("out");
  if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[2] === "child") {
  process.stdout.write(`${JSON.stringify(await child(process.argv[3], process.argv[4], process.argv[5], Number(process.argv[6]), Number(process.argv[7])))}\n`);
} else {
  await orchestrate();
}
