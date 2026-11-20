import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCloudComputerTool } from "../../server/cloud-computer-tools.ts";
import type { AppConfig } from "../../server/config.ts";
import { fillSecureField, type SecureFormDesk } from "../../server/laterdog/secure-form.ts";
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

  it("zoom shows a region at the real screen's detail, and stays capped at 1024 pixels wide", async () => {
    const sizeOf = (result: Awaited<ReturnType<typeof call>>) => {
      const image = result.content.find((part) => part.type === "image") as { data: string } | undefined;
      return image ? jpegSize(Buffer.from(image.data, "base64")) : result.content;
    };
    expect(sizeOf(await call("zoom", { x: 0, y: 0, width: 256, height: 160 }))).toEqual({ width: 320, height: 200 });
    expect(sizeOf(await call("zoom", { x: 900, y: 600, width: 400, height: 100 }))).toEqual({ width: 155, height: 50 });
    expect(sizeOf(await call("zoom", { x: 0, y: 0, width: 1024, height: 640 }))).toEqual({ width: 1024, height: 640 });
  });
});

describe("where a dog's click lands on a 1280x800 cloud desktop", () => {
  it("does not wait for the pointer when it is already where the click goes", async () => {
    const fake = fakeXdotool({ x: 640, y: 400 });
    const clicked = await runCloudComputerTool(cfg, "fixture", "click", { x: 512, y: 320 }, signal, undefined, undefined, fake.exec);
    expect(clicked.isError).not.toBe(true);
    expect(fake.log().filter((line) => line.startsWith("mousemove"))).toEqual([]);
    expect(fake.log()).toContain("click --repeat 1 --delay 100 1");
  });

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

describe("where a Secure Form's value is typed on a 1280x800 cloud desktop", () => {
  const desk: SecureFormDesk = {
    open: () => ({ error: "unused" }),
    field: () => ({ ok: true, host: "login.example.test", label: "Password", value: "S3cret-pass!" }),
    typed: () => ({ last: true }),
    result: () => ({ ok: true, text: "unused" }),
  };
  const landing = (log: string[]) => log.find((line) => line.startsWith("mousemove"));

  it("is where a click at the same screenshot point lands, at each corner of the page area and the centre", async () => {
    for (const [x, y] of [[0, 100], [1023, 100], [0, 639], [1023, 639], [512, 320]]) {
      const clicked = fakeXdotool();
      await runCloudComputerTool(cfg, "fixture", "click", { x, y }, signal, undefined, undefined, clicked.exec);
      const filled = fakeXdotool();
      const result = await fillSecureField({ form_id: "f1", field_id: "password", x, y }, desk, (command) => filled.exec(command, signal));
      expect([x, y, result.ok, landing(filled.log())]).toEqual([x, y, true, landing(clicked.log())]);
    }
  });
});
