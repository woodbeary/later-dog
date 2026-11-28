import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeMessageDatabase } from "../../../../server/message-db.ts";
import {
  applyPendingWorkspaceRestoreAtBoot,
  commitPendingWorkspaceRestore,
  createWorkspaceBackupSnapshot,
  stageWorkspaceBackup,
} from "../../../../server/workspace-backup.ts";
import {
  capture,
  readCatalog,
  verifiedRows,
} from "../migration/history/package.mjs";
import { compact } from "../migration/history/projection.mjs";
import { digest } from "../migration/history/sqlite.mjs";

const clean: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of clean.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it("exports an encrypted workspace with remote rows, exact accepted receipt bytes and a readable desktop database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portable-history-"));
  clean.push(dir);
  const root = join(dir, "active"),
    desktop = join(dir, "desktop"),
    pack = join(dir, "pack");
  mkdirSync(root);
  mkdirSync(desktop);
  const source = join(dir, "messages.db"),
    db = new DatabaseSync(source);
  initializeMessageDatabase(db);
  const msg = {
    id: "m",
    role: "user",
    text: "saved",
    at: 7,
    kind: "text",
    attachments: [{ path: "work/a" }],
  };
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
    "a",
    "m",
    7,
    "user",
    "text",
    "saved",
    JSON.stringify(msg),
  );
  db.exec("INSERT INTO thread_state VALUES('a','m')");
  const opaque = " history:v1:opaque with original whitespace ";
  db.prepare("INSERT INTO command_receipts VALUES('test','old',2,?)").run(
    opaque,
  );
  db.close();
  const receipt = await capture(source, pack),
    shard = readCatalog(pack, receipt.sha256).shards[0],
    generation = "portable-check";
  await compact(
    source,
    pack,
    receipt.sha256,
    join(root, "history-control.db"),
    generation,
  );
  writeFileSync(join(root, "messages.db"), "stale retired local DB");
  writeFileSync(join(root, "messages-removed.json"), "[]");
  const values = new Map([
    [digest(opaque), opaque],
    [digest("new"), "new"],
  ]);
  let sequence = 0,
    change = false;
  let restore: {
    jobId: string;
    status: string;
    physicalGeneration: string;
    previousRevision: number;
    generation: string;
  } | null = null;
  vi.stubGlobal("fetch", async (input: string, options: RequestInit) => {
    const path = new URL(input).pathname.split("/").at(-1),
      q = typeof options.body === "string" ? JSON.parse(options.body) : {};
    expect((options.headers as Record<string, string>).authorization).toBe(
      path === "restore" ? "Bearer writer" : "Bearer reader",
    );
    const reply = (v: unknown) => Response.json(v);
    switch (path) {
      case "restore":
        if (q.op === "begin")
          restore = {
            jobId: q.jobId,
            generation,
            physicalGeneration: "new",
            status: "preparing",
            previousRevision: 8,
          };
        else if (q.op === "undo" && restore) restore.status = "undone";
        else if (q.op !== "status") throw Error("Unexpected restore operation");
        return reply(restore);
      case "status":
        return reply({ mode: "remote", generation, revision: 8 });
      case "threads":
        return reply({ threads: ["a"], next: null });
      case "export-check":
        sequence++;
        return reply({
          items: [
            {
              threadId: "a",
              version: change ? sequence : 7,
              commandHead: "3",
              nativeEventSequence: "5",
              hasUserMessage: true,
            },
          ],
        });
      case "export-page":
        return reply({
          rows: [...verifiedRows(pack, "a", q.table, shard)],
          next: null,
        });
      case "export-commands":
        return reply({
          rows: [
            {
              sequence: "3",
              rowid: "5",
              kind: "test",
              key: "new",
              at: "8",
              resultRef: "history:v1:" + digest("new"),
            },
          ],
          next: null,
        });
      case "receipts-batch":
        if (q.op === "put")
          return new Response("object storage unavailable", { status: 503 });
        return reply({
          items: q.items.map(({ sha256 }: { sha256: string }) => ({
            sha256,
            value: values.get(sha256),
          })),
        });
      default:
        throw Error("Unexpected history request");
    }
  });
  const auth = {
      url: "https://fixture.invalid/history",
      token: "reader",
      generation,
    },
    password = "encrypted-history-fixture";
  const result = await createWorkspaceBackupSnapshot(
    root,
    { password },
    undefined,
    auth,
  );
  expect(result.summary.messages).toBe(1);
  const preview = await stageWorkspaceBackup(desktop, result.path, {
      password,
    }),
    saved = join(desktop, ".backups", preview.id, "staged", "data");
  expect(existsSync(join(saved, "history-control.db"))).toBe(false);
  expect(existsSync(join(saved, "messages-removed.json"))).toBe(false);
  const restored = new DatabaseSync(join(saved, "messages.db"), {
    readOnly: true,
  });
  try {
    expect(restored.prepare("SELECT json FROM messages").get()?.json).toBe(
      JSON.stringify(msg),
    );
    expect(
      restored.prepare("SELECT active_leaf_id FROM thread_state").get()
        ?.active_leaf_id,
    ).toBe("m");
    expect(
      restored
        .prepare(
          "SELECT rowid, key, result FROM command_receipts ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { rowid: 1, key: "old", result: opaque },
      { rowid: 5, key: "new", result: "new" },
    ]);
  } finally {
    restored.close();
  }
  const original = digest(readFileSync(join(root, "history-control.db")));
  const incoming = await stageWorkspaceBackup(root, result.path, { password });
  commitPendingWorkspaceRestore(root, incoming.id);
  const outcome = await applyPendingWorkspaceRestoreAtBoot(root, undefined, {
    ...auth,
    restoreToken: "writer",
  });
  expect(outcome).toEqual({
    restored: false,
    rolledBack: true,
    id: incoming.id,
  });
  expect(restore).toMatchObject({ jobId: incoming.id, status: "undone" });
  expect(digest(readFileSync(join(root, "history-control.db")))).toBe(original);
  for (const marker of ["history-restore.json", "pending-restore.json"])
    expect(existsSync(join(root, ".backups", marker))).toBe(false);
  expect(
    existsSync(join(root, ".backups", incoming.id, "restore-error.json")),
  ).toBe(true);
  change = true;
  await expect(
    createWorkspaceBackupSnapshot(root, { password }, undefined, auth),
  ).rejects.toThrow("changed during workspace backup");
});
