import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { archiveCompatible } from "../runtime/archive-capability.mjs";

it("refuses an older pushed bundle even when unpacking inherited the image's capability manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-capability-"));
  try {
    const launcher = join(root, "cloud-home-start.js");
    writeFileSync(launcher, "launcher fixture");
    writeFileSync(join(root, "index.js"), "new server with restore");
    expect(await archiveCompatible(launcher)).toBe(false);
    const indexSha256 = createHash("sha256").update("new server with restore").digest("hex");
    writeFileSync(join(root, "cloud-home-capabilities.json"), JSON.stringify({ logArchive: 2, indexSha256, launcherSha256: createHash("sha256").update("launcher fixture").digest("hex") }));
    expect(await archiveCompatible(launcher)).toBe(true);
    writeFileSync(join(root, "index.js"), "old server without restore");
    expect(await archiveCompatible(launcher)).toBe(false);
    writeFileSync(join(root, "cloud-home-capabilities.json"), "{broken");
    expect(await archiveCompatible(launcher)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
