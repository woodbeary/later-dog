import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { switchLauncher } from "../runtime/launcher-switch.mjs";

function server(exitAfterMs: number) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    signals: [] as string[],
    kill(signal: string) {
      child.signals.push(signal);
      setTimeout(() => { child.signalCode = signal; child.emit("exit", null, signal); }, exitAfterMs);
      return true;
    },
  });
  return child;
}

describe("switching to pushed server code", () => {
  it("starts the new server as soon as the old one stops, while a slow save carries on behind it", async () => {
    const order: string[] = [];
    let finishSave = () => {};
    const slowSave = new Promise<void>((resolve) => { finishSave = resolve; });
    const previous = server(5);
    const switched = await switchLauncher({
      previous,
      start: () => order.push("started"),
      save: () => { order.push("save began"); return slowSave.then(() => order.push("save finished")); },
    });
    expect(switched).toBe(true);
    expect(previous.signals).toEqual(["SIGTERM"]);
    expect(order).toEqual(["started", "save began"]);
    finishSave();
    await slowSave;
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["started", "save began", "save finished"]);
  });

  it("forces an old server that will not stop, then starts the new one", async () => {
    const stubborn = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, signals: [] as string[],
      kill(signal: string) { stubborn.signals.push(signal); if (signal === "SIGKILL") setTimeout(() => stubborn.emit("exit", null, signal), 1); return true; } });
    let started = 0;
    expect(await switchLauncher({ previous: stubborn, start: () => { started += 1; }, save: async () => {}, stopMs: 10 })).toBe(true);
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(started).toBe(1);
  });

  it("starts nothing when the home is stopping while the old server exits", async () => {
    let started = 0;
    let saved = 0;
    expect(await switchLauncher({ previous: server(1), carryOn: () => false, start: () => { started += 1; }, save: async () => { saved += 1; } })).toBe(false);
    expect([started, saved]).toEqual([0, 0]);
  });
});
