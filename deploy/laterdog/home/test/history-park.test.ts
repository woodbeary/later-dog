import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("drains the original process and its archive, rejects incomplete saves and restores the final SQLite write", async () => {
  const file = fileURLToPath(new URL("./history-park-process.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file]);
  expect(JSON.parse(stdout)).toMatchObject({
    childExit: 0,
    restoredMessage: "last committed message during SIGTERM",
    pausedArchive: true,
    pendingOutboxRejected: true,
  });
}, 30_000);

it("requires the original launcher to acknowledge this shutdown and exit cleanly", async () => {
  const { spawn } = await import("node:child_process");
  const { parkLauncher } = await import("../runtime/history-park.mjs");
  for (const response of ["clean", "failed", "other"]) {
    const script = `process.on("message", request => {
      process.send({type:"history.home.parked",id:process.argv[1] === "other" ? "stale" : request.id,clean:process.argv[1] !== "failed"},()=>process.exit(0));
    });`;
    const child = spawn(process.execPath, ["-e", script, response], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    if (response === "clean") await expect(parkLauncher(child)).resolves.toBeUndefined();
    else await expect(parkLauncher(child)).rejects.toThrow("complete shutdown");
  }
});

it("refuses to park a remote home while a standalone conversation write still needs delivery", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { verifyDrainedHistory } = await import("../runtime/history-park.mjs");
  const home = mkdtempSync(join(tmpdir(), "history-park-pending-"));
  try {
    const db = new DatabaseSync(join(home, "history-control.db"));
    db.exec("CREATE TABLE history_outbox(id TEXT PRIMARY KEY)");
    db.close();
    expect(() => verifyDrainedHistory(home, "remote")).not.toThrow();
    writeFileSync(join(home, "history-pending.json"), "{}");
    expect(() => verifyDrainedHistory(home, "remote")).toThrow("still needs delivery");
    expect(() => verifyDrainedHistory(home, "legacy")).not.toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
