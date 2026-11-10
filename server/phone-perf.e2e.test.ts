import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-laterdog.ts";

it("saves Run Check to its own file, never to crashes, and bounds the accepted report", async () => {
  const session = await launchVerificationServer({ ...process.env });
  const snapshot = { seconds: 20, renders: [{ name: "Chat", count: 24, perSecond: 1.2 }], events: 40, eventsPerSecond: 2, framesDropped: 10, longestStallMs: 100, heapMB: 140 };
  const report = { version: 1, at: 1, build: "9", dogs: 6, passes: [{ lean: true, switches: 24, switching: snapshot, idle: snapshot, droppedDeltas: 0, receivedDeltas: 0, watchedDeltas: 0, serverWatch: true }] };
  const post = (body: unknown) => fetch(session.info.url + "/api/phone/perf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect((await post(report)).status).toBe(201);
    const saved = JSON.parse(readFileSync(join(session.info.dataDir, "phone-perf.json"), "utf8"));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject(report);
    expect(saved[0].receivedAt).toBeGreaterThan(0);
    expect(existsSync(join(session.info.dataDir, "phone-crashes.json"))).toBe(false);
    expect((await post({ ...report, dogs: 200 })).status).toBe(400);
    expect((await post({ ...report, passes: Array(3).fill(report.passes[0]) })).status).toBe(400);
    expect((await post({ ...report, extra: "unreviewed" })).status).toBe(400);
    const listed = await (await fetch(session.info.url + "/api/phone/perf")).json() as { reports: unknown[] };
    expect(listed.reports).toHaveLength(1);
  } finally {
    await session.close();
  }
}, 60_000);
