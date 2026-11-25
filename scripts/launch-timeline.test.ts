import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultAppData,
  fixtureEnvironment,
  markTimes,
  median,
  percentile,
  protectedPorts,
  refusal,
  segmentsOf,
  summarize,
  table,
} from "./launch-timeline.mjs";

const realHome = "/home/person";
const appData = "/home/person/.config";

describe("launch timeline isolation", () => {
  it("accepts a fresh temporary folder", () => {
    expect(refusal({ dataRoot: "/tmp/laterdog-launch-timeline-abc", realHome, env: {}, argv: [], appData })).toBeNull();
  });

  it("refuses live data however it is asked for", () => {
    expect(refusal({ dataRoot: "/tmp/x", realHome, env: { LATERDOG_USE_MY_LIVE_DOGS: "1" }, argv: [], appData })).toMatch(/never uses live data/);
    expect(refusal({ dataRoot: "/tmp/x", realHome, env: {}, argv: ["--use-my-live-dogs-and-real-data"], appData })).toMatch(/never uses live data/);
  });

  it.each([
    "/home/person/.laterdog",
    "/home/person/.laterdog/inner",
    "/home/person/.laterdog-profiles",
    "/home/person/.laterdog-dev",
    "/home/person/.laterdog-dev-profiles/a",
    "/home/person/.laterdog-v0",
    "/home/person/.laterdog-dev-scripts",
    "/home/person/.config/later.dog",
    "/home/person/.config/later.dog Dev/desktop",
    "/home/person",
    "/home",
  ])("refuses %s", (dataRoot) => {
    expect(refusal({ dataRoot, realHome, env: {}, argv: [], appData })).toMatch(/Refusing/);
  });

  it("knows where each platform keeps app profiles", () => {
    expect(defaultAppData("/Users/p", "darwin", {})).toBe("/Users/p/Library/Application Support");
    expect(defaultAppData("/home/p", "linux", {})).toBe("/home/p/.config");
    expect(defaultAppData("/home/p", "linux", { XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg");
  });

  it("guards every port an installed or Dev later.dog owns", () => {
    const ports = protectedPorts();
    for (const port of [8799, 8800, 9010, 8999, 9000, 9110]) expect(ports).toContain(port);
  });

  it("gives the app and its server only the fixture's folders and the Dev variant", () => {
    const env = fixtureEnvironment({
      base: { PATH: "/bin", LATERDOG_URL: "http://live", LATERDOG_TOKEN: "t", LATERDOG_USER_DATA: "/live", LATERDOG_STATIC_DIR: "/live/ui", LATERDOG_USE_MY_LIVE_DOGS: "1", HOME: realHome },
      home: "/tmp/f/home",
      dataDir: "/tmp/f/data",
      serverPort: 8999,
      timelineFile: "/tmp/f/run.json",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/tmp/f/home",
      XDG_CONFIG_HOME: join("/tmp/f/home", ".config"),
      LATERDOG_HOME: "/tmp/f/data",
      LATERDOG_VARIANT: "dev",
      LATERDOG_SERVER_PORT: "8999",
      ELECTRON_START_URL: "http://127.0.0.1:8999",
      LATERDOG_LAUNCH_TIMELINE: "/tmp/f/run.json",
    });
    for (const key of ["LATERDOG_URL", "LATERDOG_TOKEN", "LATERDOG_USER_DATA", "LATERDOG_STATIC_DIR", "LATERDOG_USE_MY_LIVE_DOGS"]) expect(env).not.toHaveProperty(key);
  });
});

describe("launch timeline statistics", () => {
  it("takes the median and the nearest-rank percentile", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 0.95)).toBe(10);
    expect(percentile(ten, 0.5)).toBe(5);
    expect(percentile([], 0.95)).toBeNull();
  });

  const run = (offset: number, firstPaint: number, ready: number) => ({
    spawnedAt: 1_000 + offset,
    serverBootMs: 700 + offset,
    report: {
      marks: [
        { name: "main-process-start", at: 1_030 + offset },
        { name: "app-ready", at: 1_200 + offset },
        { name: "create-window", at: 1_400 + offset },
        { name: "window-shown", at: 1_700 + offset },
        { name: "renderer-first-paint", at: firstPaint + offset },
        { name: "renderer-message-box-ready", at: ready + offset },
      ],
    },
  });

  it("measures to the message box on screen, the later of its first pixel and its readiness", () => {
    expect(markTimes(run(0, 1_750, 1_720)).get("message-box-on-screen")).toBe(1_750);
    const durations = segmentsOf(run(0, 1_720, 2_800));
    expect(durations).toMatchObject({
      "electron boot": 30,
      "app ready → create window": 200,
      "window shown → message box on screen": 1_100,
      "total: spawn → message box on screen": 1_800,
      "fixture server boot (outside app)": 700,
    });
    expect(durations).not.toHaveProperty("native splash wait");
  });

  it("summarizes each segment with n, median, p95 and range", () => {
    const rows = summarize([run(0, 1_720, 2_800), run(10, 1_720, 2_900), run(20, 1_720, 3_000)]);
    const total = rows.find((row) => row.label === "total: spawn → message box on screen");
    expect(total).toEqual({ label: "total: spawn → message box on screen", n: 3, median: 1_900, p95: 2_000, min: 1_800, max: 2_000 });
    expect(table("Repeat", rows)).toContain("| total: spawn → message box on screen | 3 | 1900 | 2000 | 1800–2000 |");
  });
});
