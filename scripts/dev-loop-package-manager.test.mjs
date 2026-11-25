import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { plan } from "./dev-loop.mjs";

const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function metro(
  packageManager,
  version = { status: 0, signal: null, stdout: "1.4.5\n" },
  bun = "1.4.5",
) {
  const phoneRepo = mkdtempSync(join(tmpdir(), "laterdog-phone-manager-"));
  folders.push(phoneRepo);
  writeFileSync(
    join(phoneRepo, "package.json"),
    JSON.stringify({ packageManager, devDependencies: { bun } }),
  );
  return {
    phoneRepo,
    run: () => version,
    launch: () =>
      plan({
        home: { kind: "mine", account: null, session: "/fixture/session.json" },
        lan: "192.168.1.20",
        phoneRepo,
        tunnel: null,
        run: () => version,
        node: "/node24/bin/node",
      }).find((service) => service.name === "metro"),
  };
}

describe("the desktop dev loop follows the phone package manager", () => {
  it("starts Expo with the phone's verified local Bun", () => {
    const f = metro("bun@1.4.5");
    expect(f.launch()).toMatchObject({
      file: join(f.phoneRepo, "node_modules/bun/bin/bun.exe"),
      args: ["run", "expo", "start", "--go", "--port", "8081"],
    });
  });
  it("keeps the exact declared pnpm through Corepack during the transition", () => {
    const f = metro("pnpm@10.28.1");
    expect(f.launch()).toMatchObject({
      file: "corepack",
      args: ["pnpm@10.28.1", "exec", "expo", "start", "--go", "--port", "8081"],
    });
  });
  it.each([
    { status: 0, signal: null, stdout: "1.4.4\n" },
    { status: 0, signal: "SIGTERM", stdout: "1.4.5\n" },
    { status: null, signal: null, error: new Error("ENOENT"), stdout: "" },
  ])("refuses an unavailable or unverified Bun %#", (version) => {
    expect(() => metro("bun@1.4.5", version).launch()).toThrow(/Bun 1\.4\.5/);
  });
  it("refuses a manager/checker pin disagreement", () => {
    expect(() => metro("bun@1.4.5", undefined, "1.4.4").launch()).toThrow(/Bun 1\.4\.5/);
  });
  it.each([undefined, "bun@latest", "npm@11.0.0"])(
    "refuses an unsupported phone manager %s",
    (manager) => {
      expect(() => metro(manager).launch()).toThrow(/package manager/);
    },
  );
});
