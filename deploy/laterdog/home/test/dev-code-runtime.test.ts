import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devCodeWatcher, unpackDevCode } from "../runtime/dev-code.mjs";

function bundle(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "dev-code-src-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const archive = join(mkdtempSync(join(tmpdir(), "dev-code-tgz-")), "code.tgz");
  execFileSync("tar", ["-czf", archive, "-C", dir, "."]);
  const bytes = new Uint8Array(readFileSync(archive));
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

function image() {
  const base = mkdtempSync(join(tmpdir(), "dev-code-base-"));
  writeFileSync(join(base, "cloud-home-start.js"), "image launcher");
  mkdirSync(join(base, "drivers"));
  writeFileSync(join(base, "drivers", "kept.js"), "from the image");
  return base;
}

describe("server code pushed to a test home", () => {
  it("lays the pushed files over the image's server and keeps the rest", async () => {
    const base = image();
    const root = mkdtempSync(join(tmpdir(), "dev-code-root-"));
    const { bytes, hash } = bundle({ "cloud-home-start.js": "pushed launcher" });
    const launcher = await unpackDevCode({ hash, bytes, base, root });
    expect(readFileSync(launcher, "utf8")).toBe("pushed launcher");
    expect(readFileSync(join(launcher, "..", "drivers", "kept.js"), "utf8")).toBe("from the image");
    expect(readFileSync(join(base, "cloud-home-start.js"), "utf8")).toBe("image launcher");
  });

  it("refuses a bundle whose bytes do not match the pointer", async () => {
    const { bytes } = bundle({ "cloud-home-start.js": "pushed" });
    await expect(unpackDevCode({ hash: "0".repeat(64), bytes, base: image(), root: mkdtempSync(join(tmpdir(), "r-")) })).rejects.toThrow(/does not match/);
  });

  it("starts on the pushed code it finds, then reports only a new push", async () => {
    const pushes = [bundle({ "cloud-home-start.js": "one" }), bundle({ "cloud-home-start.js": "two" })];
    let at = 0;
    const store = {
      devCode: async () => ({ hash: pushes[at]!.hash, label: `push ${at + 1}` }),
      devBundle: async (hash: string) => pushes.find((push) => push.hash === hash)!.bytes,
    };
    const logs: string[] = [];
    const watcher = devCodeWatcher({ store, base: image(), root: mkdtempSync(join(tmpdir(), "w-")), log: (line: string) => logs.push(line), onCode: async () => {} });
    const first = await watcher.first();
    expect(first?.label).toBe("push 1");
    expect(readFileSync(first!.launcher, "utf8")).toBe("one");
    expect(await watcher.first()).toBeNull();
    at = 1;
    const second = await watcher.first();
    expect(readFileSync(second!.launcher, "utf8")).toBe("two");
    expect(logs).toEqual([]);
  });

  it("keeps running what it has when the store cannot be read", async () => {
    const logs: string[] = [];
    const store = { devCode: async () => { throw new Error("dev code read failed: 502"); }, devBundle: async () => new Uint8Array() };
    const watcher = devCodeWatcher({ store, base: image(), root: tmpdir(), log: (line: string) => logs.push(line), onCode: async () => {} });
    expect(await watcher.first()).toBeNull();
    expect(logs).toEqual(["pushed server code: dev code read failed: 502"]);
  });
});
