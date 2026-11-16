import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { imageTokens, jpegSize, SCREENSHOT_SCRIPT, screenCommand } from "./screen-commands.ts";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("the measured screen commands are the ones a dog's computer runs", () => {
  it("takes the screenshot with the computers service's own script", () => {
    expect(source("deploy/laterdog/computers/src/computer.ts")).toContain(`const SCREENSHOT_SCRIPT = \`${SCREENSHOT_SCRIPT}\`;`);
  });

  it("keeps today's native commands for the before numbers, while the dog's tools now scale the same commands", () => {
    const tools = source("server/cloud-computer-tools.ts");
    expect(tools).toContain("const mouse = pointerTo(a.x, a.y);");
    expect(tools).toContain('case "click": command = scaled(`${mouse} && xdotool click --repeat ${a.count ?? 1} --delay 100 ${buttons[String(a.button ?? "left")]}`)');
    expect(tools).toContain("case \"type_text\": command = `printf %s ${quote(Buffer.from(String(a.text)).toString(\"base64\"))} | base64 -d | xclip -selection clipboard && xdotool key --clearmodifiers ctrl+v`");
    expect(tools).toContain("case \"key_press\": command = `xdotool key --clearmodifiers ${quote(String(a.key))}`");
    expect(tools).toContain("case \"scroll\": command = scaled(`${mouse} && xdotool click --repeat ${a.amount ?? 3} --delay 80 ${scrollButtons[String(a.direction)]}`)");
    expect(screenCommand({ tool: "click", x: 10, y: 20 })).toBe("xdotool mousemove --sync 10 20 click --repeat 1 --delay 100 1");
    expect(screenCommand({ tool: "scroll", x: 1, y: 2, direction: "down", amount: 10 })).toBe("xdotool mousemove --sync 1 2 click --repeat 10 --delay 80 5");
    expect(screenCommand({ tool: "key_press", key: "Tab" })).toBe("xdotool key --clearmodifiers 'Tab'");
  });

  it("reads a JPEG's size from its frame header", () => {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03]);
    expect(jpegSize(header)).toEqual({ width: 1280, height: 800 });
  });

  it("estimates image tokens from pixels, shrinking past the long-edge and area limits", () => {
    expect(imageTokens(1280, 800)).toBe(1366);
    expect(imageTokens(1024, 640)).toBe(874);
    expect(imageTokens(1920, 1080)).toBe(imageTokens(1430, 804));
  });
});
