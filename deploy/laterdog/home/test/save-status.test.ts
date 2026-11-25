import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LISTED_UNSAVED, SAVE_STATUS_VERSION, SLOW_COPY_MS, saveRecorder, slowCopies, writeSaveStatus } from "../runtime/save-status.mjs";
import { readSaveStatus } from "../../../../server/laterdog/save-status.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "laterdog-save-status-"));
  roots.push(root);
  return root;
}

const copy = { path: "messages.db", place: "memory", bytes: 1_070_000_000, copyMs: 4_000, hashMs: 3_000 };

it("records a save from start to end: what it copied where, what disk it held at the peak, and what it could not save", async () => {
  const written: Array<Record<string, unknown>> = [];
  let clock = 1_000;
  const recorder = saveRecorder({ write: async (status: Record<string, unknown>) => { written.push(status); return true; }, now: () => (clock += 10) });
  await recorder.started({ final: false });
  await recorder.copying({ path: "messages.db", place: "disk", bytes: 500 });
  await recorder.copying({ path: "small.db", place: "disk", bytes: 20 });
  await recorder.copying({ path: "chats.db", place: "memory", bytes: 900 });
  const unsaved = Array.from({ length: LISTED_UNSAVED + 5 }, (_, index) => `file-${index}`);
  await recorder.finished({ written: true, uploaded: 3, deferred: 1, unsaved, unsavedReason: "no room for a copy", copies: [copy], heldOnDiskBytes: 480, heldInMemoryBytes: 880 });
  expect(written[0]).toMatchObject({ version: SAVE_STATUS_VERSION, state: "saving", final: false, startedAt: 1_010, heldOnDiskBytes: 0, heldInMemoryBytes: 0 });
  expect(written[1]).toMatchObject({ state: "saving", copying: "messages.db", heldOnDiskBytes: 500 });
  expect(written[2]).toMatchObject({ heldOnDiskBytes: 500 });
  expect(written[3]).toMatchObject({ heldOnDiskBytes: 500, heldInMemoryBytes: 900, copying: "chats.db" });
  const last = written.at(-1)!;
  expect(last).toMatchObject({
    state: "saved", startedAt: 1_010, endedAt: 1_060, durationMs: 50, heldOnDiskBytes: 480, heldInMemoryBytes: 880, copies: [copy], written: true, uploaded: 3, deferred: 1,
    unsaved: { count: LISTED_UNSAVED + 5, paths: unsaved.slice(0, LISTED_UNSAVED), reason: "no room for a copy" },
  });
  expect(JSON.parse(JSON.stringify(last))).not.toHaveProperty("copying");
});

it("marks a failed save, and ignores news that does not belong to a save in progress", async () => {
  const written: Array<Record<string, unknown>> = [];
  const recorder = saveRecorder({ write: async (status: Record<string, unknown>) => { written.push(status); return true; }, now: () => 5 });
  await recorder.copying({ path: "messages.db", place: "disk", bytes: 1 });
  await recorder.failed(new Error("before any save"));
  expect(written).toEqual([]);
  await recorder.started();
  await recorder.failed(new Error("store unreachable"));
  await recorder.finished({ uploaded: 1 });
  expect(written.map((status) => status.state)).toEqual(["saving", "failed"]);
  expect(written[1]).toMatchObject({ failure: "store unreachable" });
});

it("writes statuses one after another, so a slow write never lands over a newer one", async () => {
  const landed: string[] = [];
  const recorder = saveRecorder({
    write: async (status: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, status.state === "saving" && !status.copying ? 30 : 1));
      landed.push(String(status.copying ?? status.state));
      return true;
    },
  });
  void recorder.started();
  void recorder.copying({ path: "messages.db", place: "memory", bytes: 1 });
  await recorder.finished({});
  expect(landed).toEqual(["saving", "messages.db", "saved"]);
});

it("keeps going when a write fails", async () => {
  let calls = 0;
  const recorder = saveRecorder({ write: async () => { calls += 1; throw new Error("disk gone"); } });
  await recorder.started();
  await recorder.finished({});
  expect(calls).toBe(2);
});

it("writes the status whole and readable by everyone, and the server reads it back", async () => {
  const root = folder();
  const path = join(root, "save-status.json");
  const statuses: Array<Record<string, unknown>> = [];
  const recorder = saveRecorder({ write: async (status: Record<string, unknown>) => { statuses.push(status); return writeSaveStatus(path, status); } });
  await recorder.started();
  await recorder.finished({ written: true, uploaded: 2, unsaved: [], copies: [copy], heldOnDiskBytes: 0, heldInMemoryBytes: copy.bytes });
  expect(statSync(path).mode & 0o777).toBe(0o644);
  expect(readdirSync(root)).toEqual(["save-status.json"]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(statuses.at(-1))));
  expect(readSaveStatus(path)).toMatchObject({ state: "saved", heldOnDiskBytes: 0, heldInMemoryBytes: copy.bytes, copies: [copy] });
});

it("reports a write it could not make, without leaving pieces behind or following a planted link", async () => {
  const root = folder();
  expect(await writeSaveStatus(join(root, "missing", "save-status.json"), { state: "saved" })).toBe(false);
  const target = join(root, "target.txt");
  writeFileSync(target, "untouched");
  const path = join(root, "save-status.json");
  symlinkSync(target, path);
  expect(await writeSaveStatus(path, { state: "saved" })).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("untouched");
  expect(readdirSync(root).sort()).toEqual(["save-status.json", "target.txt"]);
});

it("names each database whose copy and hashing took longer than a few seconds", () => {
  expect(slowCopies([copy, { ...copy, path: "logs_2.sqlite", place: "disk", bytes: 68 * 1024 * 1024, copyMs: 300, hashMs: 200 }])).toEqual([
    "saving messages.db (1020 MB) took 4.0 s to copy to memory and 3.0 s to hash and upload",
  ]);
  expect(slowCopies([{ ...copy, copyMs: SLOW_COPY_MS - 1, hashMs: 0 }])).toEqual([]);
  expect(slowCopies(undefined)).toEqual([]);
});
