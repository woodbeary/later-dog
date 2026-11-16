import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCloudComputerTool } from "../../server/cloud-computer-tools.ts";
import type { AppConfig } from "../../server/config.ts";
import { fakeXdotool } from "./fake-xdotool.ts";
import { localExec } from "./no-vision.ts";
import { jpegSize } from "./screen-commands.ts";

const tools = ["Xvfb", "xdotool", "scrot"].every((name) => spawnSync("bash", ["-c", `command -v ${name}`]).status === 0);
const cfg = {} as AppConfig;
const signal = new AbortController().signal;

describe.skipIf(!tools)("screenshots a dog sees on a 1280x800 cloud desktop", () => {
  let xvfb: ChildProcess;
  let display = "";
  const exec = () => localExec({ DISPLAY: display });
  const call = (name: string, args: Record<string, unknown> = {}) => runCloudComputerTool(cfg, "fixture", name, args, signal, undefined, undefined, exec());

  beforeAll(async () => {
    let number = 90 + Math.floor(Math.random() * 400);
    while (existsSync(`/tmp/.X11-unix/X${number}`)) number++;
    display = `:${number}`;
    xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!existsSync(`/tmp/.X11-unix/X${number}`) && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 100));
  });
  afterAll(() => { xvfb?.kill("SIGTERM"); });

  it("are capped at 1024 pixels wide and compressed, and say the same size the other tools use", async () => {
    const shot = await call("screenshot");
    const image = shot.content.find((part) => part.type === "image") as { data: string } | undefined;
    expect(image).toBeDefined();
    const bytes = Buffer.from(image!.data, "base64");
    expect(jpegSize(bytes)).toEqual({ width: 1024, height: 640 });
    expect(bytes.length).toBeLessThan(45_000);
    const size = await call("get_screen_size");
    expect(JSON.parse((size.content[0] as { text: string }).text).stdout.trim()).toBe("1024 640");
  });
});

describe("where a dog's click lands on a 1280x800 cloud desktop", () => {
  it("is the matching point of the real screen at each corner and the centre of the screenshot", async () => {
    for (const [x, y, realX, realY] of [[0, 0, 0, 0], [1023, 0, 1278, 0], [0, 639, 0, 798], [1023, 639, 1278, 798], [512, 320, 640, 400]]) {
      const fake = fakeXdotool();
      const moved = await runCloudComputerTool(cfg, "fixture", "click", { x, y }, signal, undefined, undefined, fake.exec);
      expect(moved.isError).not.toBe(true);
      expect([x, y, fake.log().find((line) => line.startsWith("mousemove"))]).toEqual([x, y, expect.stringContaining(`mousemove --sync ${realX} ${realY}`)]);
    }
    const drag = fakeXdotool();
    await runCloudComputerTool(cfg, "fixture", "drag", { x: 0, y: 0, to_x: 1023, to_y: 639 }, signal, undefined, undefined, drag.exec);
    expect(drag.log().join(" ")).toContain("mousemove --sync 1278 798");
  });
});
