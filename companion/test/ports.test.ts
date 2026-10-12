import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");

const start = (env: Record<string, string>): Promise<{ code: number | null; err: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
        ...(process.env.LATERDOG_COMPANION_DIR ? { LATERDOG_COMPANION_DIR: process.env.LATERDOG_COMPANION_DIR } : {}),
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, err }));
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref?.();
  });

describe("port conflicts with the harness", () => {
  it("refuses the harness's own port, and says so", async () => {
    const { code, err } = await start({ LATERDOG_SERVER_PORT: "9100", LATERDOG_COMPANION_PORT: "9100" });
    expect(code).toBe(1);
    expect(err).toContain("LATERDOG_COMPANION_PORT");
    expect(err).toContain("the harness itself");
  }, 20_000);

  it("refuses the webhook receiver's port, and names it", async () => {
    const { code, err } = await start({ LATERDOG_SERVER_PORT: "9100", LATERDOG_COMPANION_PORT: "9101" });
    expect(code).toBe(1);
    expect(err).toContain("9101");
    expect(err).toContain("webhook receiver");
  }, 20_000);

  it("refuses it for the control port too", async () => {
    const { code, err } = await start({
      LATERDOG_SERVER_PORT: "9100",
      LATERDOG_COMPANION_PORT: "9200",
      LATERDOG_CONTROL_PORT: "9101",
    });
    expect(code).toBe(1);
    expect(err).toContain("LATERDOG_CONTROL_PORT");
    expect(err).toContain("webhook receiver");
  }, 20_000);

  it("refuses to put the device port and the control port on one socket", async () => {
    const { code, err } = await start({
      LATERDOG_SERVER_PORT: "9100",
      LATERDOG_COMPANION_PORT: "9300",
      LATERDOG_CONTROL_PORT: "9300",
    });
    expect(code).toBe(1);
    expect(err).toContain("LATERDOG_COMPANION_PORT");
    expect(err).toContain("LATERDOG_CONTROL_PORT");
    expect(err).toContain("9300");
    expect(err).not.toContain("already in use");
  }, 20_000);

  it("follows LATERDOG_WEBHOOK_PORT rather than assuming the port above", async () => {
    const { code, err } = await start({
      LATERDOG_SERVER_PORT: "9100",
      LATERDOG_WEBHOOK_PORT: "9500",
      LATERDOG_COMPANION_PORT: "9500",
    });
    expect(code).toBe(1);
    expect(err).toContain("webhook receiver");

    const moved = await start({
      LATERDOG_SERVER_PORT: "9100",
      LATERDOG_WEBHOOK_PORT: "9500",
      LATERDOG_COMPANION_PORT: "9101",
      LATERDOG_CONTROL_PORT: "9500",
    });
    expect(moved.code).toBe(1);
    expect(moved.err).toContain("LATERDOG_CONTROL_PORT");
    expect(moved.err).not.toContain("LATERDOG_COMPANION_PORT");
  }, 40_000);
});
