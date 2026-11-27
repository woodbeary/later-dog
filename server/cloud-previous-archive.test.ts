import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previousCloud, previousCloudArchiveBytes, stagePreviousCloud } from "./cloud-move.ts";
import { createWorkspaceBackupSnapshot } from "./workspace-backup.ts";
import {
  ARCHIVE_READ_BYTES,
  PREVIOUS_BACKUP_REFERENCE,
  previousBackupBridge,
} from "./laterdog/previous-cloud-archive.ts";
vi.mock("./cloud-secrets-boot.ts", () => ({
  BOOT_CLOUD_SECRETS: { LATERDOG_CLOUD_ARCHIVE_TOKEN: "previous-fixture" },
}));
const temp: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const p of temp.splice(0)) rmSync(p, { recursive: true, force: true });
});
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
it("lists and restores the pinned previous cloud backup and its signed replacement through bounded authenticated ranges", async () => {
  const directory = mkdtempSync(join(tmpdir(), "previous-backup-"));
  temp.push(directory);
  const current = join(directory, "current"),
    restore = join(directory, "restore"),
    folder = join(restore, ".backups", "cloud-previous");
  mkdirSync(current);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(current, "bots.json"),
    JSON.stringify([
      { id: "fixture", name: "Fixture" },
      { id: "second", name: "Second" },
    ]),
  );
  const bytes = Buffer.alloc(ARCHIVE_READ_BYTES + 37, 0x67);
  writeFileSync(join(current, "large.dat"), bytes);
  const password = "previous-fixture-secret";
  const backup = await createWorkspaceBackupSnapshot(current, { password }),
    archive = readFileSync(backup.path);
  const chunks: string[] = [],
    raw = new Map<string, Buffer>(),
    cold = new Map<string, Buffer>();
  for (let offset = 0; offset < archive.length; offset += ARCHIVE_READ_BYTES) {
    const b = archive.subarray(offset, offset + ARCHIVE_READ_BYTES),
      id = hash(b);
    raw.set(id, b);
    chunks.push(id);
  }
  const baseline = hash("original verified coordinator root");
  const secret = "fixture-bootstrap",
    token = "previous-fixture";
  const mod = await import(new URL("../deploy/laterdog/home/runtime/archive.mjs", import.meta.url).href);
  const signatures = await import(
    new URL("../deploy/laterdog/home/runtime/previous-backup-signature.mjs", import.meta.url).href
  );
  const independentlyVerified = vi.fn(async (descriptor: unknown) => {
    expect(
      await signatures.verifyPreviousBackupSignatureWithKey(
        await signatures.derivePreviousBackupKey(secret),
        descriptor,
      ),
    ).toBe(true);
    expect(await signatures.verifyPreviousBackupSignature("unrelated-tenant", descriptor)).toBe(false);
  });
  const store = {
    verifyPreviousBackup: independentlyVerified,
    async workFolderPlacement() {
      return { mode: "folders", baselineManifest: baseline };
    },
    async legacyManifest(id: string) {
      expect(id).toBe(baseline);
      return {
        entries: [
          { type: "file", path: ".laterdog/.backups/cloud-previous/workspace.dogbackup", size: archive.length, chunks },
        ],
      };
    },
    async get(id: string) {
      return raw.get(id);
    },
    async getArchived(id: string) {
      return cold.get(id);
    },
    async hasArchived(id: string) {
      return cold.has(id);
    },
    async putArchived(id: string, data: Buffer) {
      cold.set(id, Buffer.from(data));
    },
  };
  const host = await mod.serveArchive(mod.createArchiver({ root: directory, store, previousBackupSecret: secret }), {
    token,
  });
  vi.stubEnv("LATERDOG_CLOUD_ARCHIVE_URL", host.url);
  writeFileSync(
    join(folder, "previous.json"),
    JSON.stringify({ password, createdAt: new Date().toISOString(), contents: { bots: 2, rooms: 0, chats: 0 } }),
  );
  try {
    const bridge = previousBackupBridge(host.url, token);
    const reference = { v: 1 as const, source: "baseline" as const, baseline, size: archive.length };
    for (const ref of [reference, await bridge.seal(backup.path)]) {
      writeFileSync(join(folder, PREVIOUS_BACKUP_REFERENCE), JSON.stringify(ref));
      expect(previousCloud(restore)).toMatchObject({ bots: 2, bytes: archive.length });
      expect(previousCloudArchiveBytes(restore)).toBe(archive.length);
      const staged = await stagePreviousCloud(restore, "0.0.1");
      expect(hash(readFileSync(join(restore, ".backups", staged.id, "staged", "data", "large.dat")))).toBe(hash(bytes));
      expect(existsSync(join(folder, "workspace.dogbackup"))).toBe(false);
      expect(await bridge.source(ref).read(ARCHIVE_READ_BYTES - 10, 26)).toEqual(
        archive.subarray(ARCHIVE_READ_BYTES - 10, ARCHIVE_READ_BYTES + 16),
      );
      if (ref.source === "archive") {
        await expect(bridge.source({ ...ref, signature: "0".repeat(64) }).read(0, 1)).rejects.toThrow(/422/);
      }
    }
    expect(independentlyVerified).toHaveBeenCalledTimes(1);
    independentlyVerified.mockRejectedValueOnce(new Error("fixture verification outage"));
    await expect(bridge.seal(backup.path)).rejects.toThrow();
    await expect(bridge.source({ ...reference, baseline: "0".repeat(64) }).read(0, 1)).rejects.toThrow(/422/);
    await expect(previousBackupBridge(host.url, "incorrect").source(reference).read(0, 1)).rejects.toThrow(/401/);
  } finally {
    await host.close();
  }
}, 60_000);
