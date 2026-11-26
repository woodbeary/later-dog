#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const count = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

export function usageFiles(location) {
  const root = resolve(location);
  if (!existsSync(root)) throw new Error(`No usage ledger at ${root}`);
  if (statSync(root).isFile()) return [root];
  const folder = existsSync(join(root, "usage")) ? join(root, "usage") : root;
  return readdirSync(folder).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().map((name) => join(folder, name));
}

export function readRows(location, { since, until } = {}) {
  const rows = [];
  for (const file of usageFiles(location)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row?.at !== "string" || typeof row.input !== "number") continue;
      if (since && row.at < since) continue;
      if (until && row.at >= until) continue;
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

const measured = (row) => typeof row.cachedInput === "number" && count(row.input) > 0;

function tally(rows) {
  const total = { turns: 0, input: 0, cached: 0, written: 0, unmeasured: 0 };
  for (const row of rows) {
    if (!measured(row)) { total.unmeasured += 1; continue; }
    const input = count(row.input);
    total.turns += 1;
    total.input += input;
    total.cached += Math.min(count(row.cachedInput), input);
    total.written += count(row.cachedWrite);
  }
  return { ...total, hitRate: total.input ? total.cached / total.input : null, writeRate: total.input ? total.written / total.input : null };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const name = key(row);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  return groups;
}

export function chatSegments(rows) {
  const segments = [];
  for (const row of rows) {
    const last = segments.at(-1);
    if (last && last.account === row.instanceId) last.rows.push(row);
    else segments.push({ account: row.instanceId, rows: [row] });
  }
  return segments.map((segment) => ({ account: segment.account, from: segment.rows[0].at, to: segment.rows.at(-1).at, ...tally(segment.rows) }));
}

export function buildReport(rows) {
  const byAccount = [...groupBy(rows, (row) => row.instanceId ?? "unknown")]
    .map(([account, list]) => ({ account, ...tally(list) })).sort((a, b) => b.input - a.input);
  const byChat = [...groupBy(rows, (row) => row.threadId ?? "unknown")]
    .map(([chat, list]) => ({
      chat, dog: list.find((row) => row.botName)?.botName ?? null, ...tally(list),
      accounts: [...new Set(list.map((row) => row.instanceId))],
      segments: chatSegments(list),
    }))
    .sort((a, b) => b.input - a.input);
  const moved = byChat.filter((chat) => chat.accounts.length > 1);
  return { total: tally(rows), byAccount, byChat, moved: moved.map(({ chat, dog, segments }) => ({ chat, dog, segments })) };
}

const percent = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const line = (cells, widths) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd();

function table(heads, rows) {
  const widths = heads.map((head, index) => Math.max(head.length, ...rows.map((row) => String(row[index]).length)));
  return [line(heads, widths), ...rows.map((row) => line(row, widths))].join("\n");
}

const cells = (entry) => [entry.turns, entry.input, entry.cached, entry.written, percent(entry.hitRate), entry.unmeasured];
const HEADS = ["turns", "input", "cached", "written", "hit", "unmeasured"];

export function formatReport(report, { top = 15 } = {}) {
  const out = [];
  out.push(`All turns: ${cells(report.total).join("  ")}  (${HEADS.join("  ")})`);
  out.push("", "Per account", table(["account", ...HEADS], report.byAccount.map((entry) => [entry.account, ...cells(entry)])));
  out.push("", `Per chat (top ${top} by input)`, table(["chat", "dog", ...HEADS], report.byChat.slice(0, top).map((entry) => [entry.chat.slice(0, 12), entry.dog ?? "", ...cells(entry)])));
  if (report.moved.length) {
    out.push("", "Chats that changed account, in order");
    for (const chat of report.moved) {
      out.push(`${chat.chat.slice(0, 12)} ${chat.dog ?? ""}`.trimEnd());
      for (const segment of chat.segments) out.push(`  ${segment.account}  ${segment.from} .. ${segment.to}  turns ${segment.turns}  input ${segment.input}  hit ${percent(segment.hitRate)}`);
    }
  }
  return out.join("\n");
}

function parseArgs(argv) {
  const options = { json: false, top: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--since") options.since = argv[++index];
    else if (arg === "--until") options.until = argv[++index];
    else if (arg === "--top") options.top = Number(argv[++index]);
    else if (arg === "--chat") options.chat = argv[++index];
    else if (arg === "--account") options.account = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!arg.startsWith("--")) options.location = arg;
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

const USAGE = `Usage: node scripts/cache-hit-report.mjs [data-dir | usage-dir | month.jsonl] [--since ISO] [--until ISO] [--chat id-prefix] [--account id] [--top N] [--json]
Reports prompt cache hit rates (cached input over input) per account and per chat from the usage ledger.
Default location: $LATERDOG_HOME, else ~/.laterdog.`;

export function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { console.log(USAGE); return 0; }
  const location = options.location ?? process.env.LATERDOG_HOME ?? join(homedir(), ".laterdog");
  let rows = readRows(location, options);
  if (options.chat) rows = rows.filter((row) => String(row.threadId).startsWith(options.chat));
  if (options.account) rows = rows.filter((row) => row.instanceId === options.account);
  const report = buildReport(rows);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report, options));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
