import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ARCHIVE_CAPABILITY, FOLDER_AWAY_CAPABILITY, archiveCompatible, bringsFoldersBack } from "../runtime/archive-capability.mjs";
import { pushedServerRefusal } from "../runtime/folder-away.mjs";

it("refuses an older pushed bundle, including one that only knows log archives, even when unpacking inherited the image's capability manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-capability-"));
  try {
    const launcher = join(root, "cloud-home-start.js");
    writeFileSync(launcher, "launcher fixture");
    writeFileSync(join(root, "index.js"), "new server with restore");
    expect(await archiveCompatible(launcher)).toBe(false);
    const indexSha256 = createHash("sha256").update("new server with restore").digest("hex");
    const launcherSha256 = createHash("sha256").update("launcher fixture").digest("hex");
    writeFileSync(join(root, "cloud-home-capabilities.json"), JSON.stringify({ logArchive: 2, indexSha256, launcherSha256 }));
    expect(await archiveCompatible(launcher)).toBe(false);
    writeFileSync(join(root, "cloud-home-capabilities.json"), JSON.stringify({ logArchive: ARCHIVE_CAPABILITY, indexSha256, launcherSha256 }));
    expect(ARCHIVE_CAPABILITY).toBe(3);
    expect(await archiveCompatible(launcher)).toBe(true);
    writeFileSync(join(root, "index.js"), "old server without restore");
    expect(await archiveCompatible(launcher)).toBe(false);
    writeFileSync(join(root, "cloud-home-capabilities.json"), "{broken");
    expect(await archiveCompatible(launcher)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("knows which pushed servers can bring chats' files back, and refuses the others in plain words while any are away", async () => {
  const root = mkdtempSync(join(tmpdir(), "folder-capability-"));
  try {
    const launcher = join(root, "cloud-home-start.js");
    writeFileSync(launcher, "launcher fixture");
    writeFileSync(join(root, "index.js"), "server");
    const indexSha256 = createHash("sha256").update("server").digest("hex");
    const launcherSha256 = createHash("sha256").update("launcher fixture").digest("hex");
    writeFileSync(join(root, "cloud-home-capabilities.json"), JSON.stringify({ logArchive: ARCHIVE_CAPABILITY, indexSha256, launcherSha256 }));
    expect(await archiveCompatible(launcher)).toBe(true);
    expect(await bringsFoldersBack(launcher)).toBe(false);
    writeFileSync(join(root, "cloud-home-capabilities.json"), JSON.stringify({ logArchive: ARCHIVE_CAPABILITY, folderAway: FOLDER_AWAY_CAPABILITY, indexSha256, launcherSha256 }));
    expect(await bringsFoldersBack(launcher)).toBe(true);
    writeFileSync(join(root, "cloud-home-capabilities.json"), JSON.stringify({ logArchive: 2, folderAway: FOLDER_AWAY_CAPABILITY, indexSha256, launcherSha256 }));
    expect(await bringsFoldersBack(launcher)).toBe(false);
    const hash = "ab".repeat(32);
    expect(pushedServerRefusal({ away: 0, bringsBack: false, hash })).toBeNull();
    expect(pushedServerRefusal({ away: 3, bringsBack: true, hash })).toBeNull();
    expect(pushedServerRefusal({ away: 3, bringsBack: false, hash })).toBe(
      "the pushed server abababababab cannot bring back chats' files, and 3 chat(s) have their files in Cloud storage; using this image's server. "
      + "To bring every folder back first: POST /api/storage/folders/bring-back on this home, signed in as its owner (see docs/laterdog/folders-away.md)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
