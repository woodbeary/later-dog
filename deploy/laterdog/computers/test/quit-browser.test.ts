import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import { QUIT_BROWSER_SCRIPT } from "../src/quit-browser";
import { OWNER_KEY, type World, apiRequest, body, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const isQuit = (cmd: string[]) => cmd.includes(QUIT_BROWSER_SCRIPT);

async function running(w: World): Promise<string> {
  const created = await body(await w.fetch(apiRequest("POST", "/v1/computers", OWNER_KEY, { body: {} })));
  await w.advance(MINUTE);
  return created.computer.id;
}

describe("sleeping a computer", () => {
  it("quits Chromium gracefully, as the dog, before it syncs and takes the snapshot", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    const before = container.execs.length;
    const slept = await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    expect((await body(slept)).computer.state).toBe("sleeping");
    const after = container.execs.slice(before);
    const quitAt = after.findIndex((entry) => isQuit(entry.cmd));
    const syncAt = after.findIndex((entry) => entry.cmd.includes("sync"));
    expect(quitAt).toBeGreaterThanOrEqual(0);
    expect(quitAt).toBeLessThan(syncAt);
    expect(after[quitAt]!.options?.user).toBe("1000:1000");
    expect(container.snapshots).toBe(1);
  });

  it("still sleeps, and says so in the log, when Chromium does not quit in time", async () => {
    const w = await world();
    const id = await running(w);
    const container = w.containers.get(id)!;
    container.reply = (cmd) => (isQuit(cmd) ? { exitCode: 1 } : undefined);
    const slept = await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    expect((await body(slept)).computer.state).toBe("sleeping");
    expect(container.snapshots).toBe(1);
  });

  it("asks only the dog's own Chromium to stop, then waits for it to be gone", () => {
    expect(QUIT_BROWSER_SCRIPT).toContain('pgrep -u "$(id -u)" -x chromium');
    expect(QUIT_BROWSER_SCRIPT).toContain("kill -TERM");
    expect(QUIT_BROWSER_SCRIPT).not.toContain("kill -9");
    expect(QUIT_BROWSER_SCRIPT).not.toContain("-KILL");
  });
});
