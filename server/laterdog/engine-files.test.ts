import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ENGINE_FILE_LIMIT, ENGINE_TRANSFER_LIMIT, EngineFileReceiver, engineInventory, engineFilePath, streamedTree, workspaceRecovery, matchingTranscriptPrefix, type EngineFile } from "./engine-files.ts";

const scratch: string[] = [];
function folder() { const path = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-engine-files-"))); scratch.push(path); return path; }
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const file = (text: string, path = "result.txt"): EngineFile => ({ root: "workspace", path, size: Buffer.byteLength(text), mode: 0o600, hash: createHash("sha256").update(text).digest("hex") });

it("copies exact bytes across a checkpoint and can receive a later change", () => {
  const path = folder();
  const receiver = new EngineFileReceiver([{ id: "workspace", path, writable: true }]);
  for (const text of ["hello", "changed"] ) {
    receiver.begin(file(text)); receiver.chunk(Buffer.from(text)); receiver.end();
    expect(readFileSync(join(path, "result.txt"), "utf8")).toBe(text);
  }
});

it("synchronizes all regular files of an assigned workspace within real disk headroom", () => {
  const path = folder();
  const root = { id: "workspace", path, writable: true, streamedTree: true };
  for (const name of [".git/objects/pack/work.pack", "dist/results.txt", ".cache/important.txt", "coverage/actual.txt"]) {
    mkdirSync(join(path, name, ".."), { recursive: true });
    writeFileSync(join(path, name), name);
  }
  expect(engineInventory([root]).map(f => f.path).sort()).toEqual([".cache/important.txt", ".git/objects/pack/work.pack", "coverage/actual.txt", "dist/results.txt"]);
  const receiver = new EngineFileReceiver([root]);
  expect(() => receiver.begin({ ...file("outside capacity"), size: Number.MAX_SAFE_INTEGER })).toThrow("Insufficient disk space");
  for (const unsafe of [{ ...root, id: "account" }, { ...root, files: ["selected"] }, { ...root, readOnly: true }, { ...root, writable: false }]) {
    expect(streamedTree(unsafe)).toBe(false);
  }
  symlinkSync("dist/results.txt", join(path, "result"));
  expect(engineInventory([root]).find(file => file.path === "result")?.link).toBe("dist/results.txt");
  symlinkSync("../another-workspace", join(path, "unsafe"));
  expect(() => engineInventory([root])).toThrow("leaves its assigned working folder");
});

it("recovers independent guest work, respects home edits, and leaves ambiguous bytes and permissions intact", () => {
  const saved = file("saved");
  const local = file("new home");
  const guest = file("new guest");
  expect(workspaceRecovery("workspace", [saved], [guest], [saved])).toEqual([{ root: "workspace", path: guest.path, hash: guest.hash, mode: guest.mode }]);
  expect(workspaceRecovery("workspace", [local], [saved], [saved])).toEqual([]);
  expect(workspaceRecovery("workspace", [], [guest], [])).toHaveLength(1);
  expect(workspaceRecovery("workspace", [saved], [], [saved])).toEqual([{ root: "workspace", path: saved.path, hash: undefined, mode: undefined }]);
  expect(() => workspaceRecovery("workspace", [local], [guest], [saved])).toThrow("Both copies were preserved");
  expect(() => workspaceRecovery("workspace", [local], [guest], [])).toThrow("Both copies were preserved");
  expect(() => workspaceRecovery("workspace", [local], [], [saved])).toThrow("Both copies were preserved");
  expect(() => workspaceRecovery("workspace", [{ ...saved, mode: 0o755 }], [guest], [saved])).toThrow("Both copies were preserved");
});

it("keeps a newer home edit and refuses a conflicting deletion", () => {
  const path = folder();
  writeFileSync(join(path, "result.txt"), "before");
  const baseline = engineInventory([{ id: "workspace", path, writable: true }]);
  const receiver = new EngineFileReceiver([{ id: "workspace", path, writable: true }], baseline);
  writeFileSync(join(path, "result.txt"), "new home edit");
  expect(() => receiver.begin(file("remote edit"))).toThrow("newer home copy");
  expect(() => receiver.remove(file("before"))).toThrow("newer home copy");
  expect(readFileSync(join(path, "result.txt"), "utf8")).toBe("new home edit");
});

it("checks again after bytes arrive so a concurrent home edit survives", () => {
  const path = folder();
  writeFileSync(join(path, "result.txt"), "before");
  const roots = [{ id: "workspace", path, writable: true }];
  const receiver = new EngineFileReceiver(roots, engineInventory(roots));
  receiver.begin(file("remote")); receiver.chunk(Buffer.from("remote"));
  writeFileSync(join(path, "result.txt"), "during transfer");
  expect(() => receiver.end()).toThrow("changed while");
  expect(readFileSync(join(path, "result.txt"), "utf8")).toBe("during transfer");
});

it("admits the selected native file by available disk and keeps ordinary inventory bounded", () => {
  const path = folder();
  const session = { id: "session", path, writable: true, transcript: true, files: ["selected.jsonl"] };
  writeFileSync(join(path, "selected.jsonl"), "");
  truncateSync(join(path, "selected.jsonl"), ENGINE_TRANSFER_LIMIT + 1);
  writeFileSync(join(path, "other.dat"), "workspace input");
  const ordinary = { id: "workspace", path, writable: true, files: ["other.dat"] };
  const inventory = engineInventory([session, ordinary]);
  expect(inventory.map(file => file.size)).toEqual([ENGINE_TRANSFER_LIMIT + 1, 15]);
  expect(() => engineInventory([{ ...session, files: ["selected.jsonl", "other.dat"] }])).toThrow("too large");
  const receiver = new EngineFileReceiver([session], inventory);
  expect(() => receiver.begin({ ...inventory[0], size: Number.MAX_SAFE_INTEGER })).toThrow("Insufficient disk space");
  expect(() => receiver.begin({ ...inventory[0], size: Number.MAX_SAFE_INTEGER + 1 })).toThrow("Invalid engine file metadata");
  expect(readdirSync(path).sort()).toEqual(["other.dat", "selected.jsonl"]);
});

it("chooses a full checkpoint for rewritten or truncated transcripts", () => {
  const path = folder();
  const before = file("previous", "session.jsonl");
  const root = { id: "workspace", path, writable: true, transcript: true, files: [before.path] };
  const selected = join(path, before.path);
  writeFileSync(selected, "previous with an appended turn");
  truncateSync(selected, ENGINE_FILE_LIMIT + 1);
  const [grown] = engineInventory([root]);
  expect(matchingTranscriptPrefix(root, grown, before)).toEqual({ size: before.size, hash: before.hash });
  writeFileSync(selected, "rewritten");
  truncateSync(selected, ENGINE_FILE_LIMIT + 1);
  expect(matchingTranscriptPrefix(root, grown, before)).toBeUndefined();
  truncateSync(selected, 3);
  const [truncated] = engineInventory([root]);
  expect(matchingTranscriptPrefix(root, truncated, grown)).toBeUndefined();
});

it("verifies transcript prefixes, refuses concurrent changes, and cleans up interrupted suffixes", () => {
  const path = folder();
  const root = { id: "workspace", path, writable: true, transcript: true, files: ["result.jsonl"] };
  const before = file("prefix", "result.jsonl");
  writeFileSync(join(path, before.path), "prefix");
  const receiver = new EngineFileReceiver([root], [before]);
  receiver.begin(file("prefixsuffix", "result.jsonl"), before);
  receiver.chunk(Buffer.from("suf"));
  receiver.close();
  expect(readFileSync(join(path, before.path), "utf8")).toBe("prefix");
  receiver.begin(file("prefixsuffix", "result.jsonl"), before);
  receiver.chunk(Buffer.from("suffix"));
  writeFileSync(join(path, before.path), "newer");
  expect(() => receiver.end()).toThrow("changed while");
  expect(readFileSync(join(path, before.path), "utf8")).toBe("newer");
  expect(() => receiver.begin(file("prefixsuffix", "result.jsonl"), before)).toThrow();
  expect(readdirSync(path)).toEqual(["result.jsonl"]);
});

it("rejects traversal, read-only files and symlink escapes", () => {
  const path = folder();
  const root = { id: "workspace", path, writable: true };
  const receiver = new EngineFileReceiver([root, { id: "input", path, writable: false }]);
  for (const name of ["../outside", "/outside", "x/../outside", "x//y", "."]) expect(() => engineFilePath(root, name)).toThrow();
  symlinkSync(folder(), join(path, "escape"));
  expect(() => receiver.begin(file("bad", "escape/result.txt"))).toThrow("symbolic links");
  expect(() => receiver.begin({ ...file("bad"), root: "input" })).toThrow("writable selection");
  expect(() => receiver.begin({ ...file("bad"), root: "unknown" })).toThrow("writable selection");
});

it("does not expose corrupt or incomplete files and removes its staging file", () => {
  const path = folder();
  const roots = [{ id: "workspace", path, writable: true }];
  const receiver = new EngineFileReceiver(roots);
  receiver.begin(file("good")); receiver.chunk(Buffer.from("bad!"));
  expect(() => receiver.end()).toThrow("did not match");
  expect(existsSync(join(path, "result.txt"))).toBe(false);
  receiver.begin(file("good")); receiver.chunk(Buffer.from("go")); receiver.close();
  expect(engineInventory(roots)).toEqual([]);
});

it("leaves packages and build output on the computer and restricts selected session files", () => {
  const path = folder();
  for (const dir of ["node_modules", "build"]) { mkdirSync(join(path, dir)); writeFileSync(join(path, dir, "large"), "excluded"); }
  writeFileSync(join(path, "own.jsonl"), "own"); writeFileSync(join(path, "other.jsonl"), "other");
  const root = { id: "workspace", path, writable: true, files: ["own.jsonl"] };
  expect(engineInventory([root]).map(file => file.path)).toEqual(["own.jsonl"]);
  expect(() => new EngineFileReceiver([root]).begin(file("bad", "other.jsonl"))).toThrow("writable selection");
  expect(engineInventory([{ ...root, files: undefined }]).map(file => file.path).sort()).toEqual(["other.jsonl", "own.jsonl"]);
});

it("lists a bounded folder without large files, build output, links, excluded paths, or more than its total", () => {
  const path = folder();
  mkdirSync(join(path, "memory"), { recursive: true });
  mkdirSync(join(path, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(path, "dist"), { recursive: true });
  mkdirSync(join(path, "projects", "site"), { recursive: true });
  writeFileSync(join(path, "MEMORY.md"), "# Memory");
  writeFileSync(join(path, "memory", "topic.md"), "topic");
  writeFileSync(join(path, "big.bin"), Buffer.alloc(2048));
  writeFileSync(join(path, "node_modules", "pkg", "index.js"), "x");
  writeFileSync(join(path, "dist", "out.js"), "x");
  writeFileSync(join(path, "projects", "site", "page.html"), "x");
  writeFileSync(join(path, "projects", "notes.md"), "x");
  symlinkSync("/etc/hosts", join(path, "hosts"));
  const root = { id: "bot", path, writable: false, bounded: { fileBytes: 1024, totalBytes: 1024 * 1024, exclude: ["projects/site"] } };
  expect(engineInventory([root]).map((entry) => entry.path).sort()).toEqual(["MEMORY.md", "memory/topic.md", "projects/notes.md"]);
  const tight = engineInventory([{ ...root, bounded: { ...root.bounded, totalBytes: 9 } }]);
  expect(tight.reduce((total, entry) => total + entry.size, 0)).toBeLessThanOrEqual(9);
  expect(tight.length).toBeGreaterThan(0);
  expect(() => engineInventory([{ id: "workspace", path, writable: true }])).toThrow();
});

it("excludes generated paths in walking and explicit root.files while retaining state, cache and results", () => {
  const path = folder();
  const generated = [".open-next/assets/a", "nested/.open-next/a", "nested/.wrangler/tmp/dev/a", "nested/.next/a", "dist/a"];
  const kept = ["nested/.wrangler/state/db", "nested/.wrangler/cache/db", "src/a", "results/check.txt", ".git/HEAD"];
  for (const name of [...generated, ...kept]) { mkdirSync(join(path, name, ".."), { recursive: true }); writeFileSync(join(path, name), "x"); }
  const root = { id: "workspace", path, writable: true };
  expect(engineInventory([root]).map(f => f.path).sort()).toEqual([...kept].sort());
  expect(engineInventory([{ ...root, files: [...generated, ...kept] }]).map(f => f.path).sort()).toEqual([...kept].sort());
  expect(() => engineInventory([{ ...root, files: [".open-next/../escape"] }])).toThrow("Invalid engine file path");
});
