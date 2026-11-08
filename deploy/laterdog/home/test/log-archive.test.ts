import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createArchiver, serveArchive } from "../runtime/archive.mjs";
import { fileIsUnopened } from "../runtime/archive-ownership.mjs";
import { LogArchiveCoordinator, logArchiveBridge, threadLogPaths } from "../../../../server/laterdog/log-archive.ts";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ID = "thread-123456";
const PATH = threadLogPaths(ID)[0];
const TEXT = "saved log before the next engine starts\n";
const rootDir = () => {
  const root = mkdtempSync(join(tmpdir(), "log-archive-"));
  roots.push(root);
  return root;
};
function put(root: string, path = PATH, text = TEXT) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  utimesSync(join(root, path), new Date(0), new Date(0));
}
function memory() {
  const blobs = new Map<string, Uint8Array>();
  let index: unknown = null;
  return {
    async archiveIndex() { return structuredClone(index); },
    async putArchiveIndex(next: unknown) { index = structuredClone(next); },
    async hasArchived(hash: string) { return blobs.has(hash); },
    async putArchived(hash: string, bytes: Uint8Array) { blobs.set(hash, new Uint8Array(bytes)); },
    async getArchived(hash: string) { const found = blobs.get(hash); if (!found) throw new Error("missing"); return found; },
  };
}
async function fixture() {
  const root = rootDir();
  const store = memory();
  const archiver = createArchiver({ root, store });
  const service = await serveArchive(archiver, { token: "isolated-archive-fixture" });
  cleanups.push(service.close);
  const bridge = logArchiveBridge(service.url, "isolated-archive-fixture");
  let busy = false;
  const reports: string[] = [];
  const coordinator = () => new LogArchiveCoordinator({
    root, bridge, threads: () => [ID], idle: () => !busy, retryMs: 5,
    report: message => reports.push(message),
  });
  return { root, store, bridge, archiver, coordinator, reports, claim: () => { busy = true; } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("claims startup while upload is in flight, then restores before engine dispatch", async () => {
  const f = await fixture();
  put(f.root);
  const entered = deferred();
  const release = deferred();
  const upload = f.store.putArchived;
  f.store.putArchived = async (...args) => { entered.resolve(); await release.promise; return upload(...args); };
  const coordinator = f.coordinator();
  const scan = coordinator.scan();
  await entered.promise;
  f.claim();
  let dispatched = false;
  const startup = coordinator.beforeTurn(ID, () => true).then(ready => {
    expect(ready).toBe(true);
    expect(readFileSync(join(f.root, PATH), "utf8")).toBe(TEXT);
    dispatched = true;
  });
  await Promise.resolve();
  expect(dispatched).toBe(false);
  release.resolve();
  await Promise.all([scan, startup]);
  expect(dispatched).toBe(true);
  expect(f.reports.join(" ")).toMatch(/archived 1 logs.*free disk/);
});

it("a restarted server waits for the runtime's in-flight archive and restores exact bytes", async () => {
  const f = await fixture();
  put(f.root);
  const entered = deferred();
  const release = deferred();
  const upload = f.store.putArchived;
  f.store.putArchived = async (...args) => { entered.resolve(); await release.promise; return upload(...args); };
  const oldScan = f.coordinator().scan();
  await entered.promise;
  f.claim();
  const restarted = f.coordinator();
  const startup = restarted.beforeTurn(ID, () => true);
  release.resolve();
  await oldScan;
  expect(await startup).toBe(true);
  expect(readFileSync(join(f.root, PATH), "utf8")).toBe(TEXT);
});

it("keeps the pending turn during restore outages and retries without a chat client", async () => {
  const f = await fixture();
  put(f.root);
  await f.archiver.archive([PATH]);
  f.claim();
  const fetch = f.store.getArchived;
  let attempts = 0;
  let pending = true;
  f.store.getArchived = async hash => {
    attempts++;
    if (attempts <= 3) {
      expect(pending).toBe(true);
      expect(existsSync(join(f.root, PATH))).toBe(false);
      throw new Error("isolated storage outage");
    }
    return fetch(hash);
  };
  expect(await f.coordinator().beforeTurn(ID, () => pending)).toBe(true);
  pending = false;
  expect(attempts).toBe(4);
  expect(readFileSync(join(f.root, PATH), "utf8")).toBe(TEXT);
  expect(f.reports).toHaveLength(1);
});

it("a stopped pending turn never dispatches during a restore outage", async () => {
  const f = await fixture();
  put(f.root);
  await f.archiver.archive([PATH]);
  let current = true;
  f.store.getArchived = async () => { current = false; throw new Error("unavailable"); };
  expect(await f.coordinator().beforeTurn(ID, () => current)).toBe(false);
  expect(existsSync(join(f.root, PATH))).toBe(false);
});

it("restores history after runtime and coordinator restart and refuses a blank read on outage", async () => {
  const f = await fixture();
  put(f.root);
  await f.archiver.archive([PATH]);
  const restored = await serveArchive(createArchiver({ root: f.root, store: f.store }), { token: "restart-fixture" });
  cleanups.push(restored.close);
  const coordinator = new LogArchiveCoordinator({
    root: f.root, bridge: logArchiveBridge(restored.url, "restart-fixture"), threads: () => [ID], idle: () => true,
  });
  expect(await coordinator.read(ID, () => readFileSync(join(f.root, PATH), "utf8"))).toBe(TEXT);
  rmSync(join(f.root, PATH));
  f.store.getArchived = async () => { throw new Error("offline"); };
  let read = false;
  await expect(coordinator.read(ID, () => { read = true; })).rejects.toThrow(/not restored/);
  expect(read).toBe(false);
});

it("does not restore provider sessions or tool results through the log consumer", async () => {
  const f = await fixture();
  const provider = `.claude/projects/project/${ID}.jsonl`;
  put(f.root);
  put(f.root, provider);
  await f.archiver.archive([PATH, provider]);
  expect(await f.coordinator().beforeTurn(ID, () => true)).toBe(true);
  expect(existsSync(join(f.root, provider))).toBe(false);
  expect(readFileSync(join(f.root, PATH), "utf8")).toBe(TEXT);
});

it("bounds scans by bytes, age, known threads and current busy state", async () => {
  const f = await fixture();
  put(f.root);
  put(f.root, ".laterdog/native/unknown-123456.ndjson");
  const recent = threadLogPaths("recent-123456")[0];
  put(f.root, recent);
  utimesSync(join(f.root, recent), new Date(), new Date());
  const options = { root: f.root, bridge: f.bridge, threads: () => [ID, "recent-123456"], idle: () => true };
  await new LogArchiveCoordinator({ ...options, byteLimit: 1 }).scan();
  expect(existsSync(join(f.root, PATH))).toBe(true);
  await new LogArchiveCoordinator({ ...options, idle: () => false }).scan();
  expect(existsSync(join(f.root, PATH))).toBe(true);
  await new LogArchiveCoordinator(options).scan();
  expect(existsSync(join(f.root, PATH))).toBe(false);
  expect(existsSync(join(f.root, recent))).toBe(true);
  expect(existsSync(join(f.root, ".laterdog/native/unknown-123456.ndjson"))).toBe(true);
});

it("refuses removal when process ownership is unknown or an open descriptor names the inode", async () => {
  const root = rootDir();
  put(root);
  const proc = join(root, "proc");
  mkdirSync(join(proc, "123/fd"), { recursive: true });
  const { linkSync } = await import("node:fs");
  linkSync(join(root, PATH), join(proc, "123/fd/7"));
  expect(await fileIsUnopened(join(root, PATH), { proc })).toBe(false);
  expect(await fileIsUnopened(join(root, PATH), { proc: join(root, "missing") })).toBe(false);
  rmSync(join(proc, "123/fd/7"));
  expect(await fileIsUnopened(join(root, PATH), { proc })).toBe(true);
  const kept = createArchiver({ root, store: memory(), canRemove: async () => false });
  expect(await kept.archive([PATH])).toMatchObject({ archived: 0, skipped: [{ path: PATH, why: "open-or-unknown" }] });
  expect(existsSync(join(root, PATH))).toBe(true);
});

it("does not remove a file changed during the ownership check", async () => {
  const root = rootDir();
  put(root);
  const archive = createArchiver({
    root, store: memory(), canRemove: async () => { put(root, PATH, "newer data"); return true; },
  });
  expect(await archive.archive([PATH])).toMatchObject({ archived: 0 });
  expect(readFileSync(join(root, PATH), "utf8")).toBe("newer data");
});
