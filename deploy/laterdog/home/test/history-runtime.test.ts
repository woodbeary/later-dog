import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { bootHistory, historyExclusion, verifyHistoryControl } from "../runtime/history.mjs";

it("selects the authorized generation before restore and excludes only retired databases from the active snapshot", async () => {
  const request = async (_url: string, init: RequestInit) => {
    expect(init.headers).toMatchObject({ Authorization: "Bearer specimen" });
    return Response.json({ mode: "remote", generation: "release", revision: 4 });
  };
  const env = { LATERDOG_HISTORY_URL: "http://state.r2/history", LATERDOG_HISTORY_TOKEN: "specimen" };
  await expect(bootHistory(env, request)).resolves.toMatchObject({ mode: "remote", generation: "release" });
  await expect(bootHistory(env, async () => Response.json({ mode: "held" }))).rejects.toThrow("held");
  await expect(bootHistory(env, async () => new Response(null, { status: 503 }))).rejects.toThrow("503");
  expect(historyExclusion("remote", ".laterdog/messages.db")).toBe(true);
  expect(historyExclusion("remote", ".laterdog/messages.db-wal")).toBe(true);
  expect(historyExclusion("remote", ".laterdog/history-control.db")).toBe(false);
  expect(historyExclusion("remote", ".laterdog/history-pending.json")).toBe(false);
  expect(historyExclusion("legacy", ".laterdog/messages.db")).toBe(false);
});
it("requires the scoped saved compact database or the exact verified original while portable recovery is applying", () => {
  const root = mkdtempSync(join(tmpdir(), "history-recovery-"));
  try {
    const file = "history-control.db",
      journal = ".backups/restore-journal.json",
      id = randomUUID(),
      saved = ".backups/safety-" + id + "/data";
    const entries = (...names: string[]) => ({
      entries: names.map((name) => ({ path: ".laterdog/" + name, type: "file" })),
    });
    const db = new DatabaseSync(join(root, file));
    for (const table of ["history_control_generation", "history_receipt_generation"])
      db.exec(
        "CREATE TABLE " +
          table +
          "(singleton INTEGER PRIMARY KEY,generation TEXT);INSERT INTO " +
          table +
          " VALUES(1,'stage')",
      );
    for (const table of [
      "messages",
      "thread_state",
      "native_runs",
      "native_run_events",
      "native_run_items",
      "native_run_retention",
    ])
      db.exec("CREATE TABLE " + table + "(id TEXT)");
    db.close();
    expect(() => verifyHistoryControl(root, "stage", entries(file))).not.toThrow();
    expect(() => verifyHistoryControl(root, "other", entries(file))).toThrow();
    mkdirSync(join(root, saved), { recursive: true });
    renameSync(join(root, file), join(root, saved, file));
    writeFileSync(join(root, journal), JSON.stringify({ id, phase: "applying", existing: [file], incoming: [file] }));
    expect(() => verifyHistoryControl(root, "stage", entries(journal, saved + "/" + file))).not.toThrow();
    expect(() => verifyHistoryControl(root, "stage", entries(journal))).toThrow();
    writeFileSync(join(root, journal), JSON.stringify({ id: "../unknown", phase: "applying", existing: [file] }));
    expect(() => verifyHistoryControl(root, "stage", entries(journal, saved + "/" + file))).toThrow();
    symlinkSync(join(root, saved, file), join(root, file));
    expect(() => verifyHistoryControl(root, "stage", entries(file))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
