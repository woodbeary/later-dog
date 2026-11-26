import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeRestoreFailure, RESTORE_BACKOFF_MAX_MS, RESTORE_NOTES_KEPT, restoreBackoff, restoreUntilDone } from "../runtime/restore-until-done.mjs";
import { parseManifest, restore, snapshot } from "../runtime/sync.mjs";
import { HELD_SIGNALS, holdStopsWhileRestoring } from "../runtime/restore-signals.mjs";
import { EventEmitter } from "node:events";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const made: string[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "laterdog-home-restore-"));
  made.push(path);
  return path;
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

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

const OWNER_COLD_RESTORE_MEASURED_MS = 436_590;

describe("restoring a home until every file is back", () => {
  it("keeps going past many failed attempts while files keep coming back, so a slow restore never ends the container", async () => {
    const source = folder();
    mkdirSync(join(source, "chats"), { recursive: true });
    for (let i = 0; i < 120; i++) writeFileSync(join(source, "chats", `${i}.json`), `{"chat":${i}}`);
    const store = memoryStore();
    await snapshot(source, store, null, { scratch: folder() });
    let reads = 0;
    const dropping = { ...store, async get(hash: string) {
      reads += 1;
      if (reads % 9 === 0) throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
      return store.get(hash);
    } };
    const target = folder();
    const waits: number[] = [];
    const lines: string[] = [];
    const restored = await restoreUntilDone(
      (finished) => restore(target, dropping, null, { finished, chunkAttempts: 1 }),
      { log: (line: string) => lines.push(line), wait: async (ms: number) => { waits.push(ms); } },
    );
    expect(restored.attempts).toBeGreaterThan(5);
    expect(restored.files).toBe(120);
    expect(lines).toHaveLength(restored.attempts - 1);
    expect(lines[0]).toMatch(/^restore attempt 1 failed after \d+ more file\(s\) came back, \d+ in all, \d+ s in: TypeError: fetch failed \(other side closed \[UND_ERR_SOCKET\]\)$/);
    for (let i = 0; i < 120; i++) expect(readFileSync(join(target, "chats", `${i}.json`), "utf8")).toBe(`{"chat":${i}}`);
    expect(waits.every((ms, index) => ms === restoreBackoff(index + 1))).toBe(true);
  });

  it("gives up only once its time budget is spent, and says why each attempt failed", async () => {
    let clock = 0;
    const failure = new Error("blob read failed: 503");
    const attempt = restoreUntilDone(async () => { throw failure; }, {
      now: () => clock,
      wait: async (ms: number) => { clock += ms; },
      giveUpMs: 10 * 60_000,
    });
    await expect(attempt).rejects.toBe(failure);
    expect(clock).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("keeps only the latest notes and waits no longer than its ceiling between attempts", async () => {
    let calls = 0;
    const restored = await restoreUntilDone(async () => {
      calls += 1;
      if (calls <= RESTORE_NOTES_KEPT + 5) throw new Error(`attempt ${calls}`);
      return { manifest: null, files: 0 };
    }, { wait: async () => {} });
    expect(restored.notes).toHaveLength(RESTORE_NOTES_KEPT);
    expect(restored.notes.at(-1)).toContain(`attempt ${RESTORE_NOTES_KEPT + 5}`);
    expect(restoreBackoff(1_000)).toBe(RESTORE_BACKOFF_MAX_MS);
    expect(describeRestoreFailure(Object.assign(new Error("read failed"), { code: "ECONNRESET" }))).toBe("read failed [ECONNRESET]");
  });

  it("lets the host wait for ports well past the owner's measured cold restore", async () => {
    const { BOOT_PORT_TIMEOUT_MS } = await import("../src/host.ts");
    expect(BOOT_PORT_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * OWNER_COLD_RESTORE_MEASURED_MS);
  });

  it("holds a stop signal that arrives mid-restore, so a rollout or Worker deploy no longer throws away the restore", async () => {
    const events = new EventEmitter();
    const lines: string[] = [];
    const held = holdStopsWhileRestoring({ events, log: (line: string) => lines.push(line), now: () => 42 });
    for (const signal of HELD_SIGNALS) expect(events.listenerCount(signal)).toBe(1);
    events.emit("SIGTERM", "SIGTERM");
    expect(held.release()).toEqual([{ signal: "SIGTERM", at: 42 }]);
    for (const signal of HELD_SIGNALS) expect(events.listenerCount(signal)).toBe(0);
    expect(lines[0]).toMatch(/^SIGTERM arrived while restoring/);
  });

  it("never stops retrying on its own", async () => {
    let calls = 0;
    let clock = 0;
    const restored = await restoreUntilDone(async () => {
      calls += 1;
      if (calls < 200) throw new Error("blob read failed: 503");
      return { manifest: null, files: 0 };
    }, { now: () => clock, wait: async (ms: number) => { clock += ms; } });
    expect(restored.attempts).toBe(200);
    expect(clock).toBeGreaterThan(60 * 60_000);
  });
});

