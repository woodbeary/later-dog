import { spawn } from "node:child_process";

import { CLOUD_COMPUTER_TOOLS } from "../../server/cloud-computer-tools.ts";
import { SCREENSHOT_SCRIPT, screenActionResultText, screenCommand, type ScreenAction } from "./screen-commands.ts";
import { serveStdio } from "./stdio-mcp.ts";

export const SCREEN_TOOL_NAMES = ["screenshot", "get_screen_size", "click", "move", "drag", "type_text", "key_press", "scroll", "open_url"] as const;

export const TODAYS_DESCRIPTIONS: Record<string, string> = {
  screenshot: "See the assigned cloud desktop at native pixel resolution.",
  get_screen_size: "Get the cloud desktop width and height.",
};

export function todaysScreenTools() {
  return CLOUD_COMPUTER_TOOLS
    .filter((tool) => (SCREEN_TOOL_NAMES as readonly string[]).includes(tool.name))
    .map((tool) => (TODAYS_DESCRIPTIONS[tool.name] ? { ...tool, description: TODAYS_DESCRIPTIONS[tool.name]! } : tool));
}

const display = process.env.DISPLAY;
const chromium = process.env.LATERDOG_BROWSER_STEPS_CHROMIUM ?? "/usr/bin/chromium";
const profile = process.env.LATERDOG_BROWSER_STEPS_PROFILE;

function run(command: string): Promise<{ ok: boolean; exitCode: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((settle) => {
    const child = spawn("bash", ["-c", command], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    let done = false;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ ok: code === 0, exitCode: code, stdout: Buffer.concat(out), stderr });
    };
    child.on("close", finish);
    child.on("exit", (code) => { setTimeout(() => finish(code), 100); });
  });
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

if (import.meta.main) {
  if (!display || !profile) throw new Error("DISPLAY and LATERDOG_BROWSER_STEPS_PROFILE are required");
  serveStdio("computer", {
    list: () => todaysScreenTools(),
    call: async (tool, args) => {
      if (tool === "screenshot") {
        const shot = await run(SCREENSHOT_SCRIPT);
        if (!shot.ok) return { isError: true, content: [{ type: "text", text: shot.stderr || "screenshot failed" }] };
        return { content: [{ type: "image", mimeType: "image/jpeg", data: shot.stdout.toString("base64") }] };
      }
      let command: string;
      if (tool === "get_screen_size") command = "xdotool getdisplaygeometry";
      else if (tool === "move") command = `xdotool mousemove --sync ${Number(args.x)} ${Number(args.y)}`;
      else if (tool === "drag") command = `xdotool mousemove --sync ${Number(args.x)} ${Number(args.y)} mousedown 1 mousemove --sync ${Number(args.to_x)} ${Number(args.to_y)} mouseup 1`;
      else if (tool === "open_url") {
        if (!/^https?:\/\//.test(String(args.url))) return { isError: true, content: [{ type: "text", text: "Tool arguments do not match the advertised input schema; use its required fields and types." }] };
        command = `nohup ${quote(chromium)} --user-data-dir=${quote(profile)} ${quote(String(args.url))} >/dev/null 2>&1 </dev/null &`;
      } else if (tool === "click" || tool === "type_text" || tool === "key_press" || tool === "scroll") command = screenCommand({ tool, ...args } as ScreenAction);
      else return { isError: true, content: [{ type: "text", text: "Unknown cloud computer tool." }] };
      const result = await run(command);
      if (tool === "open_url" && result.ok) return { content: [{ type: "text", text: "Browser launch requested. Page loading is not confirmed; inspect the screen before continuing." }] };
      return { isError: !result.ok, content: [{ type: "text", text: screenActionResultText({ ok: result.ok, exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr }) }] };
    },
  });
}
