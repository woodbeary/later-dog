import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import { DESKTOP_GRACE_MS, DESKTOP_SCRIPT, PAINT_GRACE_MS } from "../src/ready";
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

const isDesktopCheck = (cmd: string[]) => cmd.includes(DESKTOP_SCRIPT);
const isScreenshot = (cmd: string[]) => cmd.some((part) => part.includes("scrot --overwrite --pointer"));

async function created(w: World): Promise<string> {
  const response = await w.fetch(apiRequest("POST", "/v1/computers", OWNER_KEY, { body: {} }));
  return (await body(response)).computer.id;
}

async function read(w: World, id: string) {
  return (await body(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY)))).computer;
}

describe("a computer starting", () => {
  it("is running as soon as the screen answers and only available once the desktop is drawn", async () => {
    const w = await world();
    const id = await created(w);
    const container = w.containers.get(id)!;
    const seen: Array<Promise<Response>> = [];
    let checks = 0;
    container.reply = (cmd) => {
      if (!isDesktopCheck(cmd)) return undefined;
      checks += 1;
      seen.push(w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY)));
      return { exitCode: checks < 3 ? 3 : 0 };
    };
    expect((await read(w, id)).state).toBe("starting");
    await w.advance(MINUTE);
    const during = await Promise.all(seen.map(async (response) => (await body(await response)).computer));
    expect(during.slice(0, 2).map((c) => [c.state, c.desktopAvailable])).toEqual([["running", false], ["running", false]]);
    const after = await read(w, id);
    expect([after.state, after.desktopAvailable]).toEqual(["running", true]);
  });

  it("keeps polling the screen until it answers, and is not running before", async () => {
    const w = await world();
    const id = await created(w);
    const container = w.containers.get(id)!;
    let probes = 0;
    container.rfbAnswers = () => ++probes > 2;
    await w.advance(MINUTE);
    expect(container.sockets.length).toBe(3);
    expect(container.sockets.every((socket) => socket.closed !== undefined)).toBe(true);
    expect((await read(w, id)).state).toBe("running");
  });

  it("does not run commands to check for the desktop before the screen answers", async () => {
    const w = await world();
    const id = await created(w);
    const container = w.containers.get(id)!;
    let probes = 0;
    container.rfbAnswers = () => ++probes > 1;
    let checkedAt = Infinity;
    container.reply = (cmd) => {
      if (isDesktopCheck(cmd)) checkedAt = Math.min(checkedAt, probes);
      return undefined;
    };
    await w.advance(MINUTE);
    expect(checkedAt).toBe(2);
  });

  it("gives up on a desktop that never draws after the 30 second grace and says so", async () => {
    const w = await world();
    const id = await created(w);
    const container = w.containers.get(id)!;
    container.reply = (cmd) => {
      if (!isDesktopCheck(cmd)) return undefined;
      w.clock.now += 10_000;
      return { exitCode: 3 };
    };
    await w.advance(MINUTE);
    const computer = await read(w, id);
    expect([computer.state, computer.desktopAvailable]).toEqual(["running", true]);
    expect(w.logs.mock.calls.some(([line]) => String(line).includes("never drew"))).toBe(true);
    expect(DESKTOP_GRACE_MS).toBe(30_000);
  });

  it("gives up on a desktop whose windows are up but never painted after 3 seconds", async () => {
    const w = await world();
    const id = await created(w);
    const container = w.containers.get(id)!;
    container.reply = (cmd) => {
      if (!isDesktopCheck(cmd)) return undefined;
      w.clock.now += 1_500;
      return { exitCode: 4 };
    };
    await w.advance(MINUTE);
    const computer = await read(w, id);
    expect([computer.state, computer.desktopAvailable]).toEqual(["running", true]);
    expect(w.logs.mock.calls.some(([line]) => String(line).includes("up but never painted"))).toBe(true);
    expect(PAINT_GRACE_MS).toBe(3_000);
  });

  it("makes a screenshot wait for the desktop to be drawn, so nobody gets a half-painted screen", async () => {
    const w = await world();
    const id = await created(w);
    const container = w.containers.get(id)!;
    let checks = 0;
    let shot: Promise<Response> | undefined;
    container.reply = (cmd) => {
      if (isScreenshot(cmd)) return { stdout: new Uint8Array([0xff, 0xd8, 0xff]) };
      if (!isDesktopCheck(cmd)) return undefined;
      checks += 1;
      shot ??= w.fetch(apiRequest("GET", `/v1/computers/${id}/screenshot`, OWNER_KEY));
      return { exitCode: checks < 3 ? 3 : 0 };
    };
    await w.advance(MINUTE);
    expect((await shot!).status).toBe(200);
    const order = container.execs.map((entry) => (isDesktopCheck(entry.cmd) ? "check" : isScreenshot(entry.cmd) ? "shot" : "other"));
    expect(order.lastIndexOf("check")).toBeLessThan(order.indexOf("shot"));
  });
});

describe("a desktop link for a computer that is still starting", () => {
  it("is minted, and the viewer page is served, while the computer starts", async () => {
    const w = await world();
    const id = await created(w);
    expect((await read(w, id)).state).toBe("starting");
    const link = await w.fetch(apiRequest("POST", `/v1/computers/${id}/desktop`, OWNER_KEY));
    expect(link.status).toBe(200);
    const { url } = await body(link);
    const page = await w.fetch(new Request(url));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('import RFB from "/novnc/1.6.0/core/rfb.js";');
    const status = await w.fetch(new Request(`${url}status`));
    expect(await status.json()).toMatchObject({ state: "starting" });
  });

  it("is still refused for a computer that is asleep", async () => {
    const w = await world();
    const id = await created(w);
    await w.advance(MINUTE);
    await w.fetch(apiRequest("POST", `/v1/computers/${id}/sleep`, OWNER_KEY));
    const link = await w.fetch(apiRequest("POST", `/v1/computers/${id}/desktop`, OWNER_KEY));
    expect(link.status).toBe(409);
  });
});
