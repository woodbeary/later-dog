import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function fileSize(random) {
  const band = random();
  if (band < 0.7) return 500 + Math.floor(random() * 3_500);
  if (band < 0.95) return 4_000 + Math.floor(random() * 60_000);
  return 64_000 + Math.floor(random() * 192_000);
}

function filePaths(count) {
  const random = seeded(7);
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const dog = Math.floor(random() * 80).toString(16).padStart(8, "0");
    const area = ["memory", "memory/log", "src", "src/lib", "docs", "notes/2026", "attachments"][Math.floor(random() * 7)];
    const home = index % 3 === 0 ? "workspaces" : "task-workspaces";
    paths.push(join(home, dog, area, `file-${index}.md`));
  }
  return paths;
}

function buildTiny(root, count) {
  const random = seeded(31);
  const made = new Set();
  for (let index = 0; index < count; index += 1) {
    const dog = Math.floor(random() * 800).toString(16).padStart(8, "0");
    const area = ["memory", "memory/log", "src", "src/lib", "docs", "notes/2026", "attachments"][Math.floor(random() * 7)];
    const folder = join(root, index % 3 === 0 ? "workspaces" : "task-workspaces", dog, area, `part-${index % 3}`);
    if (!made.has(folder)) {
      mkdirSync(folder, { recursive: true });
      made.add(folder);
    }
    writeFileSync(join(folder, `file-${index}.md`), `note ${index}\n`);
  }
  return made.size;
}

function build(root, count, databaseMegabytes) {
  const random = seeded(11);
  for (const path of filePaths(count)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, randomBytes(fileSize(random)));
  }
  const database = new DatabaseSync(join(root, "messages.db"));
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE messages (id INTEGER PRIMARY KEY, body BLOB)");
  const insert = database.prepare("INSERT INTO messages (body) VALUES (?)");
  const rows = Math.ceil((databaseMegabytes * 1024 * 1024) / 65_536);
  database.exec("BEGIN");
  for (let row = 0; row < rows; row += 1) {
    insert.run(randomBytes(64_000));
    if (row % 500 === 499) database.exec("COMMIT; BEGIN");
  }
  database.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  return statSync(join(root, "messages.db")).size;
}

function change(root, count, changes) {
  const random = seeded(Number(option("seed", "23")));
  const paths = filePaths(count);
  for (let index = 0; index < changes; index += 1) {
    const target = join(root, paths[Math.floor(random() * paths.length)]);
    writeFileSync(target, randomBytes(Math.max(200, readFileSync(target).length + Math.floor(random() * 200) - 100)));
  }
  const database = new DatabaseSync(join(root, "messages.db"));
  const insert = database.prepare("INSERT INTO messages (body) VALUES (?)");
  for (let row = 0; row < 20; row += 1) insert.run(randomBytes(4_000));
  database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  database.close();
}

const root = process.argv[3];
const count = Number(option("files", "20000"));
if (process.argv[2] === "build") {
  mkdirSync(root, { recursive: true });
  const databaseBytes = build(root, count, Number(option("db-mb", "630")));
  process.stdout.write(`${JSON.stringify({ root, files: count, databaseBytes })}\n`);
} else if (process.argv[2] === "tiny") {
  mkdirSync(root, { recursive: true });
  process.stdout.write(`${JSON.stringify({ root, files: count, folders: buildTiny(root, count) })}\n`);
} else if (process.argv[2] === "change") {
  change(root, count, Number(option("changes", "300")));
  process.stdout.write(`${JSON.stringify({ root, changed: Number(option("changes", "300")) })}\n`);
} else {
  throw new Error("make-home.mjs <build|tiny|change> <root> [--files N] [--db-mb N] [--changes N]");
}
