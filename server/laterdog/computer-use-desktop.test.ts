import { describe, expect, it } from "vitest";
import { actionTimeoutMs, captureCommand, CloudDesktop, cropCommand, FRAME_DIR, viewerExpiry, type ComputerCalls } from "./computer-use-desktop.ts";

function fakeComputer(answer: (command: string) => { exitCode: number | null; stdout: string; stderr: string } = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  link: { url: string; expiresAt: number | string } = { url: "https://cloud.later.dog/desktop/cmp_fixture12345/fixture-token/", expiresAt: "2026-11-01T12:00:00.000Z" }) {
  const commands: Array<{ id: string; command: string; timeoutMs: number }> = [];
  const reads: string[] = [];
  const calls: ComputerCalls = {
    exec: async (id, command, timeoutMs) => { commands.push({ id, command, timeoutMs }); return answer(command); },
    read: async (_id, path) => { reads.push(path); return Buffer.from(`jpeg from ${path}`); },
    desktop: async () => link,
  };
  return { calls, commands, reads };
}

describe("later.dog's cloud desktop for the loop", () => {
  it("reads the screen size from the X display", async () => {
    const computer = fakeComputer(() => ({ exitCode: 0, stdout: "1280 800\n", stderr: "" }));
    expect(await new CloudDesktop(computer.calls, "cmp_fixture12345").screen()).toEqual({ width: 1280, height: 800 });
    expect(computer.commands[0]).toMatchObject({ id: "cmp_fixture12345", command: "xdotool getdisplaygeometry" });
  });

  it("captures a native frame when the screen already fits", async () => {
    const computer = fakeComputer();
    const size = { width: 1280, height: 800 };
    const frame = await new CloudDesktop(computer.calls, "cmp_fixture12345").screenshot(size, size);
    expect(computer.commands[0]!.command).not.toContain("--thumb");
    expect(computer.reads).toEqual([`${FRAME_DIR}/frame.jpg`]);
    expect(frame.toString()).toBe(`jpeg from ${FRAME_DIR}/frame.jpg`);
  });

  it("asks scrot for a scaled copy when the screen is larger than the frame", () => {
    expect(captureCommand({ width: 1728, height: 1080 }, { width: 2560, height: 1600 })).toEqual({
      command: `mkdir -p ${FRAME_DIR} && rm -f ${FRAME_DIR}/frame.jpg ${FRAME_DIR}/frame-thumb.jpg && scrot --overwrite --pointer --quality 75 --thumb 1728x1080 ${FRAME_DIR}/frame.jpg >/dev/null`,
      path: `${FRAME_DIR}/frame-thumb.jpg`,
    });
  });

  it("runs an action as one command and reports its failure in plain words", async () => {
    const computer = fakeComputer(() => ({ exitCode: 1, stdout: "", stderr: "Error: Can't open display: :0\n" }));
    const desktop = new CloudDesktop(computer.calls, "cmp_fixture12345");
    await expect(desktop.act({ kind: "key", keys: "Return", repeat: 1 })).rejects.toThrow("The key action failed: Error: Can't open display: :0.");
    expect(computer.commands[0]!.command).toBe("xdotool key --clearmodifiers --repeat 1 --delay 50 Return");
  });

  it("gives long typing and held keys enough time", () => {
    expect(actionTimeoutMs({ kind: "key", keys: "a", repeat: 1 })).toBe(30_000);
    expect(actionTimeoutMs({ kind: "hold_key", keys: "shift", seconds: 10 })).toBe(40_000);
    expect(actionTimeoutMs({ kind: "type", text: "x".repeat(2000) })).toBe(60_000);
  });

  it("mints the computer's signed viewer link for a take-over", async () => {
    const minted = await new CloudDesktop(fakeComputer().calls, "cmp_fixture12345").viewer();
    expect(minted).toEqual({ url: "https://cloud.later.dog/desktop/cmp_fixture12345/fixture-token/", expiresAt: "2026-11-01T12:00:00.000Z" });
    expect(viewerExpiry(1_793_534_400)).toBe("2026-11-01T12:00:00.000Z");
    expect(viewerExpiry(1_793_534_400_000)).toBe("2026-11-01T12:00:00.000Z");
    expect(() => viewerExpiry("soon")).toThrow("no readable expiry");
  });

  it("refuses a viewer link the person could not open, such as the service binding's own host", async () => {
    const internal = fakeComputer(undefined, { url: "http://computers.internal/desktop/cmp_fixture12345/fixture-token/", expiresAt: "2026-11-01T12:00:00.000Z" });
    await expect(new CloudDesktop(internal.calls, "cmp_fixture12345").viewer()).rejects.toThrow("not https");
  });

  it("crops the region around a click target with scrot for the guard", async () => {
    const computer = fakeComputer();
    const crop = await new CloudDesktop(computer.calls, "cmp_fixture12345").crop({ x: 660, y: 560, width: 480, height: 240 });
    expect(computer.commands[0]!.command).toBe(`mkdir -p ${FRAME_DIR} && rm -f ${FRAME_DIR}/crop.jpg && scrot --overwrite --autoselect 660,560,480,240 --quality 75 ${FRAME_DIR}/crop.jpg >/dev/null`);
    expect(crop.toString()).toBe(`jpeg from ${FRAME_DIR}/crop.jpg`);
    expect(() => cropCommand({ x: -1, y: 0, width: 10, height: 10 })).toThrow("invalid crop");
    expect(() => cropCommand({ x: 0, y: 0, width: 0, height: 10 })).toThrow("invalid crop");
  });
});
