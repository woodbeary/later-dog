import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

const TABLE = ["| Step | Result | Time |", "|---|---|---|", "| Install | passed | 41 s |", "| Typecheck | passed | 18 s |", "| Tests | 1,884 passed | 3 min 12 s |", "| Export | one bundle, 5.9 MB | 58 s |"].join("\n");
const CODE = ["```ts", "export function carryOn(waiting: readonly string[], after: string | undefined): readonly string[] {", "  if (after === undefined) return waiting;", "  const start = waiting.findIndex((path) => path > after);", "  return start <= 0 ? waiting : [...waiting.slice(start), ...waiting.slice(0, start)];", "}", "```"].join("\n");
const PROSE = "The release checklist is done apart from the two items that need you. The signed build finished and passed its smoke tests on both window sizes, the update guide names the new group and the rollback target, and the pull request is merged. Nothing else changed in this pass, so the next step is yours.";
const LIST = ["Here is where things stand:", "", "- **Build:** finished and signed, with the long dog names fitting their rows.", "- **Docs:** the update guide is merged and names the rollback target.", "- **Waiting on you:** approve the screenshots and confirm the pricing line before Friday.", "", "`pnpm verify` passed in 4 min 12 s."].join("\n");
const SHAPES = [PROSE, LIST, `${PROSE}\n\n${CODE}`, `Results from this run:\n\n${TABLE}\n\n${PROSE}`, "Done. Nothing else needed.", `${LIST}\n\n${CODE}\n\n${TABLE}`];
const ASKS = ["Where does the release stand?", "Run the checks again and show me the table.", "Show me the function you changed.", "Anything still waiting on me?"];
const OUTPUT_LINE = "src/components/ChatView.tsx:412:17  the row keeps its measured height while the newest page loads\n";

function longChat(threadId, turns, startedAt) {
  const messages = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const ask = { id: `${threadId}-u${turn}`, parentId: turn === 0 ? null : `${threadId}-a${turn - 1}`, role: "user", kind: "text", at: startedAt + turn * 2_000, text: `${ASKS[turn % ASKS.length]} (Marathon, ${turn + 1})` };
    const answer = { id: `${threadId}-a${turn}`, parentId: ask.id, role: "bot", kind: "text", at: ask.at + 1_000, text: `Answer ${turn + 1}. ${SHAPES[turn % SHAPES.length]}` };
    messages.push(ask, answer);
  }
  return messages;
}

function otherMessage(threadId, index, previous, random, at) {
  const band = random();
  const id = `${threadId}-m${index}`;
  if (band < 0.25) return { id, parentId: previous, role: "user", kind: "text", at, text: `${ASKS[index % ASKS.length]} (${threadId}, ${index})` };
  if (band < 0.6) return { id, parentId: previous, role: "bot", kind: "text", at, text: `Answer ${index}. ${SHAPES[index % SHAPES.length]}` };
  const lines = band < 0.95 ? 20 + Math.floor(random() * 60) : 300 + Math.floor(random() * 500);
  return { id, parentId: previous, role: "bot", kind: "tool", at, text: "Bash", tool: { name: "Bash", ok: true, input: { command: "pnpm exec vitest run src/components" }, output: OUTPUT_LINE.repeat(lines) } };
}

function build(file, megabytes, longTurns, otherThreads) {
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));
    CREATE INDEX messages_thread ON messages(thread_id);
    CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);
  `);
  const insert = database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const leaf = database.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id");
  const random = seeded(41);
  const startedAt = 1_760_000_000_000;
  const marathon = longChat("marathon", longTurns, startedAt);
  const target = megabytes * 1024 * 1024;
  const estimatedOthers = Math.ceil(target / 6_200);
  const every = Math.max(1, Math.floor(estimatedOthers / marathon.length));
  const lastOf = new Map();
  let written = 0;
  let rows = 0;
  let nextLong = 0;
  const put = (threadId, message) => {
    const json = JSON.stringify(message);
    insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, json);
    written += json.length + (message.text?.length ?? 0) + 120;
    rows += 1;
    if (rows % 2_000 === 0) database.exec("COMMIT; BEGIN");
  };
  database.exec("BEGIN");
  for (let index = 0; written < target || nextLong < marathon.length; index += 1) {
    if (index % every === 0 && nextLong < marathon.length) put("marathon", marathon[nextLong++]);
    if (written >= target) continue;
    const threadId = `thread-${Math.floor(random() * otherThreads)}`;
    const message = otherMessage(threadId, index, lastOf.get(threadId) ?? null, random, startedAt + index * 50);
    lastOf.set(threadId, message.id);
    put(threadId, message);
  }
  for (const [threadId, id] of lastOf) leaf.run(threadId, id);
  leaf.run("marathon", marathon.at(-1).id);
  database.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  return { rows, longChatRows: marathon.length, threads: lastOf.size + 1 };
}

const file = resolve(process.argv[2]);
mkdirSync(dirname(file), { recursive: true });
const made = build(file, Number(option("db-mb", "630")), Number(option("long-turns", "120")), Number(option("threads", "400")));
process.stdout.write(`${JSON.stringify({ file, bytes: statSync(file).size, ...made })}\n`);
