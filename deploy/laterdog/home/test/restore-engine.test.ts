import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addressed, restore, restoredFirst, restorePlan, restoresLater, startRestore } from "../runtime/restore-engine.mjs";
import { DatabaseSync } from "node:sqlite";
import { parseManifest, snapshot } from "../runtime/sync.mjs";

const made: string[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "laterdog-restore-engine-"));
  made.push(path);
  return path;
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = 24 * 60 * 60_000;
const NOW = 1_795_000_000_000;

function memoryStore() {
  const blobs = new Map<string, Uint8Array>();
  let manifest: unknown = null;
  return {
    blobs,
    async manifest() { return manifest ? parseManifest(JSON.parse(JSON.stringify(manifest))) : null; },
    async putManifest(next: unknown) { manifest = next; },
    async has(hash: string) { return blobs.has(hash); },
    async get(hash: string) {
      const bytes = blobs.get(hash);
      if (!bytes) throw new Error("missing blob");
      return bytes;
    },
    async put(hash: string, bytes: Uint8Array) { blobs.set(hash, new Uint8Array(bytes)); },
  };
}

async function piecesServer(store: ReturnType<typeof memoryStore>, heldMs = 60_000) {
  const held = new Set<string>();
  const reads = new Map<string, number>();
  let release = () => {};
  let gate = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer(async (request, response) => {
    const hash = (request.url ?? "/").slice(1);
    reads.set(hash, (reads.get(hash) ?? 0) + 1);
    if (held.has(hash)) await Promise.race([gate, pause(heldMs)]);
    try {
      const bytes = await store.get(hash);
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    pieces: { url },
    held,
    reads,
    open() {
      held.clear();
      release();
    },
    close: () => new Promise<void>((resolve) => { release(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function home(): string {
  const root = folder();
  const write = (path: string, text: string, mtimeMs = NOW) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
    utimesSync(join(root, path), new Date(mtimeMs), new Date(mtimeMs));
  };
  mkdirSync(join(root, ".laterdog"), { recursive: true });
  const chats = new DatabaseSync(join(root, ".laterdog", "messages.db"));
  chats.exec("create table chats (text); insert into chats values ('every chat')");
  chats.close();
  write(".laterdog/bots.json", "[\"dog\"]");
  write(".laterdog/providers/claude-a/.credentials.json", "signed in");
  write(".laterdog/computer-runs/dog/run-new.json", "running now", NOW - 60_000);
  write(".laterdog/computer-runs/dog/run-old.json", "long finished", NOW - 5 * DAY);
  for (let i = 0; i < 40; i++) write(`.laterdog/events/thread-${String(i).padStart(4, "0")}.ndjson`, `event ${i}\n`.repeat(50), NOW - i * 1000);
  write(".laterdog/native/thread-0007.ndjson", "native seven");
  write(".laterdog/providers/claude-a/projects/p/0b8c0a0e-1111-4222-8333-444455556666.jsonl", "a session");
  write(".laterdog/attachments/picture.png", "pixels");
  write(".local/lib/tool.py", "print(1)");
  write(".laterdog/providers/codex/cache/catalog.json", "cached");
  return root;
}

async function savedHome() {
  const source = home();
  const store = memoryStore();
  const saved = await snapshot(source, store, null, { scratch: folder() });
  return { source, store, manifest: saved.manifest };
}

const LATER_LOG = ".laterdog/events/thread-0039.ndjson";

describe("what a restarting home needs before it serves", () => {
  it("brings back chats, dogs, sign-ins and running jobs first, and leaves thread logs, engine sessions, old runs, pictures and caches for later", async () => {
    const { manifest } = await savedHome();
    const plan = restorePlan(manifest, { later: restoresLater(NOW) });
    const boot = plan.boot.files.map((entry: { path: string }) => entry.path).sort();
    expect(boot).toEqual([".laterdog/bots.json", ".laterdog/computer-runs/dog/run-new.json", ".laterdog/messages.db", ".laterdog/providers/claude-a/.credentials.json"]);
    const later = plan.later.files.map((entry: { path: string }) => entry.path);
    expect(later.slice(0, 2).sort()).toEqual([".laterdog/attachments/picture.png", ".laterdog/computer-runs/dog/run-old.json"]);
    expect(later).toContain(".laterdog/providers/claude-a/projects/p/0b8c0a0e-1111-4222-8333-444455556666.jsonl");
    expect(later.slice(-2).sort()).toEqual([".laterdog/providers/codex/cache/catalog.json", ".local/lib/tool.py"]);
    expect(later.indexOf(".laterdog/events/thread-0000.ndjson")).toBeLessThan(later.indexOf(LATER_LOG));
  });
});

describe("a home that serves while the rest comes back", () => {
  it("opens once the files it needs are back, then brings back the rest, every byte exact", async () => {
    const { source, store, manifest } = await savedHome();
    const served = await piecesServer(store);
    for (const entry of restorePlan(manifest, { later: restoresLater(NOW) }).later.files) for (const hash of entry.chunks) served.held.add(hash);
    const target = folder();
    const restoring = startRestore({ root: target, manifest, pieces: served.pieces, later: restoresLater(NOW), scratch: folder() });
    const booted = await restoring.boot;
    expect(booted.files).toBe(4);
    expect(new DatabaseSync(join(target, ".laterdog", "messages.db")).prepare("select text from chats").get()).toEqual({ text: "every chat" });
    expect(restoring.pending().size).toBe(46);
    expect(readdirSync(join(target, ".laterdog", "events")).filter((name) => name.endsWith(".ndjson"))).toEqual([]);
    served.open();
    const all = await restoring.done;
    expect(all.files).toBe(50);
    expect(all.kept).toEqual([]);
    for (const entry of manifest.entries.filter((candidate: { type: string }) => candidate.type === "file")) {
      if (!entry.path.endsWith(".db")) expect(readFileSync(join(target, entry.path), "utf8")).toBe(readFileSync(join(source, entry.path), "utf8"));
      expect(statSync(join(target, entry.path)).mtimeMs).toBe(entry.mtimeMs);
    }
    await served.close();
  });

  it("fetches a dog's thread log first when a turn asks for it mid-restore, without waiting for the rest", async () => {
    const { store, manifest } = await savedHome();
    const served = await piecesServer(store, 150);
    const plan = restorePlan(manifest, { later: restoresLater(NOW) });
    const wanted = plan.later.files.find((entry: { path: string }) => entry.path === LATER_LOG);
    for (const entry of plan.later.files) if (entry !== wanted) for (const hash of entry.chunks) served.held.add(hash);
    const target = folder();
    const restoring = startRestore({ root: target, manifest, pieces: served.pieces, later: restoresLater(NOW), scratch: folder(), parallel: 2 });
    await restoring.boot;
    const calls: { paths: string[] | null; there: boolean }[] = [];
    const archiver = {
      restore: async (_needles: string[], paths: string[] | null) => {
        calls.push({ paths, there: readdirSync(join(target, ".laterdog", "events")).includes("thread-0039.ndjson") });
        return { restored: 0, bytes: 0, failed: 0, paths: [] };
      },
      restoreSessions: async () => ({ restored: 0, bytes: 0, failed: 0, paths: [] }),
    };
    await restoredFirst(archiver, restoring).restore([], [LATER_LOG]);
    expect(calls).toEqual([{ paths: [LATER_LOG], there: true }]);
    expect(readFileSync(join(target, LATER_LOG), "utf8")).toBe("event 39\n".repeat(50));
    expect(restoring.pending().size).toBeGreaterThan(30);
    const session = "0b8c0a0e-1111-4222-8333-444455556666";
    const sessionWait = restoredFirst(archiver, restoring).restoreSessions([session]);
    served.open();
    await sessionWait;
    expect(readFileSync(join(target, ".laterdog/providers/claude-a/projects/p", `${session}.jsonl`), "utf8")).toBe("a session");
    await restoring.done;
    await served.close();
  });

  it("keeps a file the running home already wrote instead of putting the older saved copy over it", async () => {
    const { store, manifest } = await savedHome();
    const served = await piecesServer(store);
    for (const entry of restorePlan(manifest, { later: restoresLater(NOW) }).later.files) for (const hash of entry.chunks) served.held.add(hash);
    const target = folder();
    const lines: string[] = [];
    const restoring = startRestore({ root: target, manifest, pieces: served.pieces, later: restoresLater(NOW), scratch: folder(), log: (line: string) => lines.push(line) });
    await restoring.boot;
    writeFileSync(join(target, LATER_LOG), "a turn already wrote this\n");
    served.open();
    const all = await restoring.done;
    expect(all.kept).toEqual([LATER_LOG]);
    expect(readFileSync(join(target, LATER_LOG), "utf8")).toBe("a turn already wrote this\n");
    await served.close();
  });

  it("keeps the running home's choice when it deletes a folder whose files are still coming back", async () => {
    const { store, manifest } = await savedHome();
    const served = await piecesServer(store);
    for (const entry of restorePlan(manifest, { later: restoresLater(NOW) }).later.files) for (const hash of entry.chunks) served.held.add(hash);
    const target = folder();
    const restoring = startRestore({ root: target, manifest, pieces: served.pieces, later: restoresLater(NOW), scratch: folder() });
    await restoring.boot;
    rmSync(join(target, ".laterdog", "providers", "codex", "cache"), { recursive: true, force: true });
    served.open();
    const all = await restoring.done;
    expect(all.attempts).toBe(1);
    expect(all.kept).toEqual([".laterdog/providers/codex/cache/catalog.json"]);
    expect(readFileSync(join(target, LATER_LOG), "utf8")).toBe("event 39\n".repeat(50));
    await served.close();
  });

  it("starts the engine again after it dies mid-restore, fetching only what is still missing and never touching what the home has changed", async () => {
    const { source, store, manifest } = await savedHome();
    const served = await piecesServer(store);
    const plan = restorePlan(manifest, { later: restoresLater(NOW) });
    const last = plan.later.files.at(-1);
    for (const hash of last.chunks) served.held.add(hash);
    const target = folder();
    const scratch = folder();
    const lines: string[] = [];
    const restoring = startRestore({ root: target, manifest, pieces: served.pieces, later: restoresLater(NOW), scratch, parallel: 1, log: (line: string) => lines.push(line), wait: async () => {} });
    await restoring.boot;
    writeFileSync(join(target, ".laterdog", "messages.db"), "a chat written after the home opened");
    while (restoring.pending().size > 1) await pause(10);
    execFileSync("pkill", ["-9", "-f", scratch]);
    served.held.clear();
    served.open();
    const all = await restoring.done;
    expect(all.attempts).toBe(2);
    expect(lines.some((line) => line.startsWith("restore attempt 1 stopped with 1 file(s) still to come"))).toBe(true);
    expect(readFileSync(join(target, ".laterdog", "messages.db"), "utf8")).toBe("a chat written after the home opened");
    expect(readFileSync(join(target, last.path), "utf8")).toBe(readFileSync(join(source, last.path), "utf8"));
    for (const entry of [...plan.boot.files, ...plan.later.files.slice(0, -1)]) for (const hash of entry.chunks) expect(served.reads.get(hash)).toBe(1);
    await served.close();
  });

  it("saves mid-restore without losing what has not come back yet, so a restart then brings back everything plus what changed", async () => {
    const { source, store, manifest } = await savedHome();
    await store.putManifest(manifest);
    const served = await piecesServer(store);
    for (const entry of restorePlan(manifest, { later: restoresLater(NOW) }).later.files) for (const hash of entry.chunks) served.held.add(hash);
    const target = folder();
    const restoring = startRestore({ root: target, manifest, pieces: served.pieces, later: restoresLater(NOW), scratch: folder() });
    await restoring.boot;
    writeFileSync(join(target, ".laterdog", "bots.json"), "[\"dog\",\"puppy\"]");
    const saved = await snapshot(target, store, manifest, { scratch: folder(), carry: new Map(restoring.pending()) });
    expect(saved.manifest.entries.map((entry: { path: string }) => entry.path)).toEqual(manifest.entries.map((entry: { path: string }) => entry.path));
    await restoring.stop();
    await served.close();
    const again = folder();
    expect((await restore(again, store, null, { scratch: folder() })).files).toBe(50);
    expect(readFileSync(join(again, ".laterdog", "bots.json"), "utf8")).toBe("[\"dog\",\"puppy\"]");
    expect(readFileSync(join(again, LATER_LOG), "utf8")).toBe(readFileSync(join(source, LATER_LOG), "utf8"));
  });
});

describe("an engine of its own", () => {
  it("keeps restoring through a stop signal, which the home holds until the files it needs are back, and stops when the home goes away", async () => {
    const { store, manifest } = await savedHome();
    const served = await piecesServer(store);
    for (const entry of restorePlan(manifest, { later: restoresLater(NOW) }).boot.files) for (const hash of entry.chunks) served.held.add(hash);
    const scratch = folder();
    const lines: string[] = [];
    const restoring = startRestore({ root: folder(), manifest, pieces: served.pieces, later: restoresLater(NOW), scratch, log: (line: string) => lines.push(line) });
    let pid = "";
    while (!pid) { try { pid = execFileSync("pgrep", ["-f", scratch], { encoding: "utf8" }).trim(); } catch { await pause(10); } }
    process.kill(Number(pid), "SIGTERM");
    process.kill(Number(pid), "SIGINT");
    await pause(100);
    served.open();
    expect((await restoring.done).attempts).toBe(1);
    expect(lines.filter((line) => line.includes("stopped"))).toEqual([]);
    await served.close();
  });
});

describe("reaching the store from the engine", () => {
  it("looks the store's name up once in the home and hands the engine the address and the name to send", async () => {
    const looked: string[] = [];
    const resolve = async (name: string) => { looked.push(name); return { address: "172.16.0.9", family: 4 }; };
    expect(await addressed("http://state.r2/blobs/", resolve)).toEqual({ url: "http://172.16.0.9/blobs/", host: "state.r2" });
    expect(await addressed("http://127.0.0.1:4100/", resolve)).toEqual({ url: "http://127.0.0.1:4100/" });
    expect(looked).toEqual(["state.r2"]);
  });
});
