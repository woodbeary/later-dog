import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { homeRuntimeBuild } from "./home-runtime-build.ts";

it("reports the loaded server bytes and identifies a pushed bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "laterdog-runtime-build-"));
  try {
    const bundlePrefix = "0123456789abcdef";
    for (const [folder, text] of [["dist-server", "image"], [join("laterdog-dev-server", bundlePrefix), "pushed"]]) {
      await mkdir(join(root, folder), { recursive: true });
      const entry = join(root, folder, "index.js");
      await writeFile(entry, text);
      const serverSha256 = createHash("sha256").update(text).digest("hex");
      expect(await homeRuntimeBuild(pathToFileURL(entry).href)).toEqual(text === "image" ? { serverSha256 } : { serverSha256, bundlePrefix });
    }
    for (const entry of ["index.ts", "index.js"]) expect(await homeRuntimeBuild(pathToFileURL(join(root, entry)).href)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
