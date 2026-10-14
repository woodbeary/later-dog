import { describe, expect, it } from "vitest";
import { DESKTOP_SCRIPT, answersRfb, desktopFromExit, holdUpstream, openUpstream } from "../src/ready";
import { FakeSocket, RFB_BANNER } from "./fake-socket";

function port(sockets: Array<string | undefined>) {
  const made: FakeSocket[] = [];
  const queue = [...sockets];
  return {
    made,
    fetch: async () => {
      const socket = new FakeSocket(queue.length > 1 ? queue.shift() : queue[0]);
      made.push(socket);
      return Object.assign(new Response(null, { status: 200 }), { webSocket: socket });
    },
  };
}

describe("the screen answering", () => {
  it("is the RFB banner coming back through the websocket, which proves the display and the VNC server are up", async () => {
    const up = port([RFB_BANNER]);
    expect(await answersRfb(up)).toBe(true);
    expect(up.made[0]!.closed?.reason).toBe("probe");
  });

  it("is not answering when the proxy accepts the socket and then closes it because the VNC server is not there yet", async () => {
    const down = port([undefined]);
    expect(await answersRfb(down)).toBe(false);
  });

  it("is not answering when something else speaks first", async () => {
    expect(await answersRfb(port(["HTTP/1.1 502"]))).toBe(false);
  });

  it("is not answering when the port refuses the connection", async () => {
    expect(await answersRfb({ fetch: async () => Promise.reject(new Error("connection refused")) })).toBe(false);
  });

  it("is not answering when the response carries no socket", async () => {
    expect(await answersRfb({ fetch: async () => new Response("nope", { status: 502 }) })).toBe(false);
  });

  it("hands back the socket with its first message so a viewer still gets the banner", async () => {
    const up = await openUpstream(port([RFB_BANNER]), 1000);
    expect(up?.first.data).toBe(RFB_BANNER);
    expect(up?.socket).toBeInstanceOf(FakeSocket);
  });
});

describe("holding a viewer's connection while the computer starts", () => {
  const clock = () => {
    const state = { now: 0, waits: [] as number[] };
    return { state, now: () => state.now, wait: async (ms: number) => void ((state.now += ms), state.waits.push(ms)) };
  };

  it("connects at once when the screen already answers", async () => {
    const c = clock();
    const result = await holdUpstream(port([RFB_BANNER]), { holdMs: 20_000, attemptMs: 1000, stillWanted: () => true, ...c });
    expect(result?.first.data).toBe(RFB_BANNER);
    expect(c.state.waits).toEqual([]);
  });

  it("retries every 250 ms until the screen answers instead of failing", async () => {
    const c = clock();
    const result = await holdUpstream(port([undefined, undefined, RFB_BANNER]), { holdMs: 20_000, attemptMs: 1000, stillWanted: () => true, ...c });
    expect(result?.first.data).toBe(RFB_BANNER);
    expect(c.state.waits).toEqual([250, 250]);
  });

  it("gives up after the hold", async () => {
    const c = clock();
    const result = await holdUpstream(port([undefined]), { holdMs: 1000, attemptMs: 1000, stillWanted: () => true, ...c });
    expect(result).toBeNull();
    expect(c.state.waits).toHaveLength(4);
  });

  it("tries once when it is told not to wait", async () => {
    const c = clock();
    const result = await holdUpstream(port([undefined]), { holdMs: 0, attemptMs: 1000, stillWanted: () => true, ...c });
    expect(result).toBeNull();
    expect(c.state.waits).toEqual([]);
  });

  it("stops holding when the computer is no longer starting", async () => {
    const c = clock();
    let wanted = true;
    const result = await holdUpstream(port([undefined]), { holdMs: 20_000, attemptMs: 1000, stillWanted: () => wanted, now: c.now, wait: async (ms) => { wanted = false; await c.wait(ms); } });
    expect(result).toBeNull();
    expect(c.state.waits).toEqual([250]);
  });
});

describe("the desktop being drawn", () => {
  it("reads the check's exit code", () => {
    expect(desktopFromExit(0)).toBe("drawn");
    expect(desktopFromExit(4)).toBe("unpainted");
    expect(desktopFromExit(3)).toBe("missing");
    expect(desktopFromExit(1)).toBe("missing");
  });

  it("needs the panel and the desktop windows, and pixels in the panel and the wallpaper, not just windows", () => {
    expect(DESKTOP_SCRIPT).toContain("xdotool search --onlyvisible --class '^xfce4-panel$'");
    expect(DESKTOP_SCRIPT).toContain("xdotool search --onlyvisible --class '^xfdesktop$'");
    expect(DESKTOP_SCRIPT).toContain("scrot --overwrite --autoselect");
    expect(DESKTOP_SCRIPT).toContain("exit 4");
  });
});
