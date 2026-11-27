import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { capabilitySecret, verifyCapabilitySync } from "./signed-capability-node.ts";
import { ensureHistoryOutbox, noteHistoryChat, noteHistoryMessage, outboxSize } from "./history-outbox-db.ts";
import { HistoryWriter, type HistoryDatabase } from "./history-writer.ts";
import { chatHistory, serveHistory, type ChatHistoryPort } from "../../deploy/laterdog/home/src/chat-history.ts";

const HOME = "hfeedfacecafe0123456789ab";
const SECRET = "bootstrap-secret-for-tests";

function localDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));
    CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);
  `);
  ensureHistoryOutbox(database);
  return database;
}

function port(database: DatabaseSync): HistoryDatabase {
  return {
    read: (read) => read(database),
    write: (write) => {
      database.exec("BEGIN");
      try {
        const result = write(database);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function objects() {
  const chats = new Map<string, ChatHistoryPort>();
  let down = false;
  const calls: string[] = [];
  const chatFor = (home: string, chat: string) => {
    const key = `${home}/${chat}`;
    if (!chats.has(key)) {
      const database = new DatabaseSync(":memory:");
      chats.set(key, chatHistory({ exec: (query, ...bindings) => { const rows = database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[]; return { toArray: () => rows }; } }));
    }
    return chats.get(key)!;
  };
  const fetcher = (async (_url: string, init: RequestInit) => {
    if (down) throw new Error("connection refused");
    const token = String((init.headers as Record<string, string>).authorization).slice("Bearer ".length);
    const check = verifyCapabilitySync(capabilitySecret(SECRET), token, { home: HOME, now: Date.now(), kinds: ["turns"] });
    if (!check.ok) return Response.json({ error: check.reason }, { status: 401 });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(`${check.claims.chat}:${String(body.op)}`);
    return serveHistory(body, check.claims, chatFor);
  }) as unknown as typeof fetch;
  return { chatFor, fetcher, calls, setDown: (value: boolean) => { down = value; } };
}

function write(database: DatabaseSync, threadId: string, id: string, text: string, at = Date.now()) {
  const json = JSON.stringify({ id, at, role: "user", kind: "text", text });
  database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', ?, ?) ON CONFLICT(thread_id, id) DO UPDATE SET json = excluded.json, text = excluded.text")
    .run(threadId, id, at, text, json);
  database.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id").run(threadId, id);
  noteHistoryMessage(database, threadId, id);
  noteHistoryChat(database, threadId, false);
}

function writer(database: DatabaseSync, remote: ReturnType<typeof objects>, known: string[] = []) {
  let outbox = false;
  const filled: string[] = [];
  const instance = new HistoryWriter({
    origin: "https://home.example", home: HOME, bootstrapSecret: SECRET, database: port(database),
    keepOutbox: (on) => { outbox = on; }, ownerOf: () => "bot-1", knownChats: () => known, filled: (id) => filled.push(id), fetch: remote.fetcher,
  });
  return { instance, outbox: () => outbox, filled };
}

describe("history writer", () => {
  it("sends local writes to the chat object in order, with the active leaf, and empties the outbox", async () => {
    const database = localDatabase();
    const remote = objects();
    const { instance } = writer(database, remote);
    for (let i = 1; i <= 5; i += 1) write(database, "chat-a", `m${i}`, `hello ${i}`, 1000 + i);
    write(database, "chat-a", "m2", "edited");
    instance.setMode("shadow");
    await instance.idle();
    expect(database.prepare("SELECT COUNT(*) AS n FROM history_outbox").get()).toEqual({ n: 0 });
    const page = await remote.chatFor(HOME, "chat-a").pageBefore(null, 10);
    expect(page.rows.map((row) => row.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(JSON.parse(page.rows[1]!.json).text).toBe("edited");
    expect(page.leaf).toBe("m2");
  });

  it("keeps writes in the outbox while the object is unreachable and sends them once it answers", async () => {
    const database = localDatabase();
    const remote = objects();
    const { instance } = writer(database, remote);
    instance.setMode("shadow");
    await instance.idle();
    remote.setDown(true);
    write(database, "chat-b", "m1", "one");
    await instance.idle();
    expect(port(database).read(outboxSize)).toBeGreaterThan(0);
    expect(instance.state().failures).toBeGreaterThan(0);
    remote.setDown(false);
    await instance.idle();
    await instance.idle();
    expect((await remote.chatFor(HOME, "chat-b").stats()).count).toBe(1);
  });

  it("clears a deleted chat in the object", async () => {
    const database = localDatabase();
    const remote = objects();
    const { instance } = writer(database, remote);
    write(database, "chat-c", "m1", "one");
    instance.setMode("shadow");
    await instance.idle();
    database.prepare("DELETE FROM messages WHERE thread_id = 'chat-c'").run();
    noteHistoryChat(database, "chat-c", true);
    await instance.idle();
    expect((await remote.chatFor(HOME, "chat-c").stats()).count).toBe(0);
  });

  it("copies a chat that existed before the switch and checks the counts", async () => {
    const database = localDatabase();
    const remote = objects();
    for (let i = 1; i <= 450; i += 1) {
      database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES ('old', ?, ?, 'bot', 'text', 'x', ?)").run(`m${i}`, i, JSON.stringify({ id: `m${i}`, n: i }));
    }
    await remote.chatFor(HOME, "old").append([{ id: "stray", at: 1, json: "{}" }]);
    const { instance } = writer(database, remote);
    instance.setMode("shadow");
    await instance.reconcileAll("copy");
    const stats = await remote.chatFor(HOME, "old").stats();
    expect(stats.count).toBe(450);
    expect(instance.state().covered).toBe(1);
    expect(instance.state().mismatched).toEqual([]);
  });

  it("refills a chat from its object after the local copy is lost, before the turn reads it", async () => {
    const remote = objects();
    const first = localDatabase();
    const before = writer(first, remote);
    for (let i = 1; i <= 3; i += 1) write(first, "chat-d", `m${i}`, `t${i}`, 100 + i);
    before.instance.setMode("object-writer");
    await before.instance.idle();
    await before.instance.reconcileAll("record");

    const fresh = localDatabase();
    write(fresh, "chat-d", "m4", "arrived before the refill", 200);
    const after = writer(fresh, remote, ["chat-d"]);
    after.instance.setMode("object-writer");
    await after.instance.ensureChat("chat-d");
    await after.instance.idle();
    const ids = (fresh.prepare("SELECT id FROM messages WHERE thread_id = 'chat-d' ORDER BY rowid").all() as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual(["m1", "m2", "m3", "m4"]);
    expect(after.filled).toContain("chat-d");
    expect((await remote.chatFor(HOME, "chat-d").stats()).count).toBe(4);
  });

  it("prefers the object's copy of a message the local save holds an older version of", async () => {
    const remote = objects();
    const database = localDatabase();
    const { instance } = writer(database, remote, ["chat-e"]);
    write(database, "chat-e", "m1", "old");
    instance.setMode("object-writer");
    await instance.idle();
    await remote.chatFor(HOME, "chat-e").write([{ op: "put", id: "m1", at: 5, json: JSON.stringify({ id: "m1", role: "user", kind: "text", text: "newer" }) }]);
    database.prepare("DELETE FROM history_coverage").run();
    await instance.ensureChat("chat-e");
    expect((database.prepare("SELECT text FROM messages WHERE id = 'm1'").get() as { text: string }).text).toBe("newer");
  });

  it("brings every chat back from the objects on the way off", async () => {
    const remote = objects();
    const first = localDatabase();
    const on = writer(first, remote);
    write(first, "chat-f", "m1", "kept");
    on.instance.setMode("object-writer");
    await on.instance.idle();
    const fresh = localDatabase();
    const off = writer(fresh, remote, ["chat-f"]);
    off.instance.setMode("object-writer");
    await off.instance.idle();
    off.instance.setMode("off");
    await off.instance.idle();
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'chat-f'").get()).toEqual({ n: 1 });
    expect(off.outbox()).toBe(false);
  });
});
