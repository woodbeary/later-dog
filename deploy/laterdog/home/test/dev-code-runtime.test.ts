import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devCodeWatcher, homeIdle, unpackDevCode } from "../runtime/dev-code.mjs";

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

async function homeAnswering(secret: string, answer: () => { status: number; body: unknown }) {
  const server = createServer((req, res) => {
    const header = (name: string) => String(req.headers[name] ?? "");
    const expected = createHmac("sha256", secret).update(`v1\n${header("x-laterdog-cloud-timestamp")}\n${header("x-laterdog-cloud-nonce")}\nGET\n${req.url}`).digest("base64url");
    const { status, body } = header("x-laterdog-cloud-signature") === `v1=${expected}` && req.url === "/api/cloud/activity" ? answer() : { status: 401, body: { error: "invalid_signature" } };
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((resolve) => server.close(resolve)) };
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

  it("waits until no dog is working, then switches once to the newest push", async () => {
    const pushes = [bundle({ "cloud-home-start.js": "one" }), bundle({ "cloud-home-start.js": "two" }), bundle({ "cloud-home-start.js": "three" })];
    let at = 0;
    let quiet = false;
    const store = {
      devCode: async () => ({ hash: pushes[at]!.hash, label: `push ${at + 1}` }),
      devBundle: async (hash: string) => pushes.find((push) => push.hash === hash)!.bytes,
    };
    const logs: string[] = [];
    const switched: string[] = [];
    const watcher = devCodeWatcher({
      store, base: image(), root: mkdtempSync(join(tmpdir(), "w-")), log: (line: string) => logs.push(line),
      onCode: async (next: { launcher: string }) => { switched.push(readFileSync(next.launcher, "utf8")); },
      idle: async () => quiet,
    });
    await watcher.first();
    at = 1;
    expect(await watcher.tick()).toBe(false);
    at = 2;
    expect(await watcher.tick()).toBe(false);
    expect(await watcher.tick()).toBe(false);
    expect(switched).toEqual([]);
    expect(logs).toEqual([`pushed server code ${pushes[1]!.hash.slice(0, 12)} waits until no dog is working`, `pushed server code ${pushes[2]!.hash.slice(0, 12)} waits until no dog is working`]);
    quiet = true;
    expect(await watcher.tick()).toBe(true);
    expect(await watcher.tick()).toBe(false);
    expect(switched).toEqual(["three"]);
  });

  it("counts a home that cannot answer as busy, and switches anyway after waiting too long", async () => {
    const pushes = [bundle({ "cloud-home-start.js": "one" }), bundle({ "cloud-home-start.js": "two" })];
    let at = 0;
    let clock = 1_000;
    const store = {
      devCode: async () => ({ hash: pushes[at]!.hash }),
      devBundle: async (hash: string) => pushes.find((push) => push.hash === hash)!.bytes,
    };
    const logs: string[] = [];
    const switched: string[] = [];
    const watcher = devCodeWatcher({
      store, base: image(), root: mkdtempSync(join(tmpdir(), "w-")), log: (line: string) => logs.push(line),
      onCode: async (next: { launcher: string }) => { switched.push(readFileSync(next.launcher, "utf8")); },
      idle: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8799"); },
      now: () => clock, maxWaitMs: 60_000,
    });
    await watcher.first();
    at = 1;
    expect(await watcher.tick()).toBe(false);
    clock += 59_999;
    expect(await watcher.tick()).toBe(false);
    clock += 1;
    expect(await watcher.tick()).toBe(true);
    expect(switched).toEqual(["two"]);
    expect(logs.at(-1)).toBe("pushed server code waited too long for the dogs to stop; switching now");
  });

  it("drops a waiting push once pushed code is turned off", async () => {
    const pushes = [bundle({ "cloud-home-start.js": "one" }), bundle({ "cloud-home-start.js": "two" })];
    let pointer: { hash: string } | null = { hash: pushes[0]!.hash };
    let quiet = false;
    const store = {
      devCode: async () => pointer,
      devBundle: async (hash: string) => pushes.find((push) => push.hash === hash)!.bytes,
    };
    const switched: string[] = [];
    const watcher = devCodeWatcher({
      store, base: image(), root: mkdtempSync(join(tmpdir(), "w-")), log: () => {},
      onCode: async (next: { launcher: string }) => { switched.push(readFileSync(next.launcher, "utf8")); },
      idle: async () => quiet,
    });
    await watcher.first();
    pointer = { hash: pushes[1]!.hash };
    expect(await watcher.tick()).toBe(false);
    pointer = null;
    quiet = true;
    expect(await watcher.tick()).toBe(false);
    expect(switched).toEqual([]);
  });

  it("asks the server it runs whether any dog is working, signed with the home's secret", async () => {
    const secret = "a-bootstrap-secret-long-enough-for-the-home-0123456789";
    let answer = { status: 200, body: { busy: true, nextAt: null } as unknown };
    const home = await homeAnswering(secret, () => answer);
    try {
      expect(await homeIdle({ secret, port: home.port })).toBe(false);
      answer = { status: 200, body: { busy: false, nextAt: null } };
      expect(await homeIdle({ secret, port: home.port })).toBe(true);
      expect(await homeIdle({ secret: "someone-else", port: home.port })).toBe(false);
      answer = { status: 503, body: { error: "busy" } };
      expect(await homeIdle({ secret, port: home.port })).toBe(false);
      answer = { status: 200, body: "not activity" };
      expect(await homeIdle({ secret, port: home.port })).toBe(false);
      answer = { status: 404, body: { error: "not found" } };
      expect(await homeIdle({ secret, port: home.port })).toBe(true);
      expect(await homeIdle({ secret: undefined, port: home.port })).toBe(true);
    } finally {
      await home.close();
    }
    await expect(homeIdle({ secret, port: home.port })).rejects.toThrow();
  });

  it("keeps running what it has when the store cannot be read", async () => {
    const logs: string[] = [];
    const store = { devCode: async () => { throw new Error("dev code read failed: 502"); }, devBundle: async () => new Uint8Array() };
    const watcher = devCodeWatcher({ store, base: image(), root: tmpdir(), log: (line: string) => logs.push(line), onCode: async () => {} });
    expect(await watcher.first()).toBeNull();
    expect(logs).toEqual(["pushed server code: dev code read failed: 502"]);
  });
});
