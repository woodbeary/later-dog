import { expect, it } from "vitest";
import { createTurnPhases, earlySnapshot } from "./turn-head-start.ts";

it("starts the file snapshot at once, hands it to the turn, and releases it when the turn never claims it", async () => {
  const released: string[] = [];
  let started = 0;
  const claimed = earlySnapshot(async () => { started += 1; return "cmp_a.hash1"; }, (value) => released.push(value));
  expect(started).toBe(1);
  expect(await claimed.claim()).toBe("cmp_a.hash1");
  claimed.abandon();
  const dropped = earlySnapshot(async () => "cmp_a.hash2", (value) => released.push(value));
  dropped.abandon();
  dropped.abandon();
  const failed = earlySnapshot(async () => { throw new Error("computer asleep"); }, (value) => released.push(value));
  expect(await failed.claim()).toBeNull();
  await new Promise((done) => setTimeout(done, 0));
  expect(released).toEqual(["cmp_a.hash2"]);
});

it("logs one line per turn with the time each phase took", () => {
  const lines: string[] = [];
  let now = 0;
  const phases = createTurnPhases({ log: (line) => lines.push(line), now: () => now });
  phases.begin("ff3416d8-2539");
  now = 400;
  phases.mark("ff3416d8-2539", "setup");
  now = 3_400;
  phases.end("ff3416d8-2539", "engine start");
  phases.mark("ff3416d8-2539", "late");
  expect(lines).toEqual(["turn phases ff3416d8: setup 0.4 s, engine start 3.0 s"]);
});
