import { describe, expect, it } from "vitest";

import { CLOUD_COMPUTER_TOOLS, computerToolsFor, runCloudComputerTool, type RemoteExec } from "../cloud-computer-tools.ts";
import type { AppConfig } from "../config.ts";
import { screenTouchingTool } from "../screen-frame-gate.ts";

const off = {} as AppConfig;
const on = { features: { pageTools: true } } as AppConfig;
const signal = new AbortController().signal;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");

function computer(fail?: (command: string) => boolean): { exec: RemoteExec; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    exec: async (command) => {
      commands.push(command);
      if (fail?.(command)) return { ok: false, exitCode: 1, stdout: "", stderr: "xdotool: no window" };
      if (command.includes("base64 -w0")) return { ok: true, exitCode: 0, stdout: JPEG, stderr: "" };
      if (command.includes("node --input-type=module")) return { ok: true, exitCode: 0, stdout: JSON.stringify({ ok: true, text: "Page: Contact us\n- button \"Send message\" [e25]" }), stderr: "" };
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const run = (cfg: AppConfig, args: Record<string, unknown>, box = computer()) =>
  runCloudComputerTool(cfg, "box", "run_actions", args, signal, undefined, undefined, box.exec);

describe("one call for a run of actions", () => {
  it("is offered to every dog on a cloud computer", () => {
    expect(CLOUD_COMPUTER_TOOLS.map((tool) => tool.name)).toContain("run_actions");
    expect(computerToolsFor(on).map((tool) => tool.name)).toContain("run_actions");
    expect(screenTouchingTool("mcp__computer__run_actions")).toBe(true);
  });

  it("does each step in order and ends with one screenshot while the page tools are off", async () => {
    const box = computer();
    const result = await run(off, { steps: [{ action: "click", x: 10, y: 20 }, { action: "type", text: "Ada" }, { action: "key", key: "Tab" }, { action: "wait", ms: 0 }, { action: "scroll", x: 5, y: 5, direction: "down" }] }, box);
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "Done, 5 steps: click 10,20; type 3 characters; key Tab; wait 0 ms; scroll 5,5." });
    expect(result.content.slice(1)).toEqual([{ type: "image", mimeType: "image/jpeg", data: JPEG }]);
    expect(box.commands.map((command) => command.includes("xclip") ? "type" : command.includes("base64 -w0") ? "shot" : command.includes("key --clearmodifiers") ? "key" : command.includes("click --repeat 1 --delay 100") ? "click" : command.includes("--delay 80") ? "scroll" : "other"))
      .toEqual(["click", "type", "key", "scroll", "shot"]);
  });

  it("ends with the page's structure, and no picture, while the page tools are on", async () => {
    const result = await run(on, { steps: [{ action: "page_fill", ref: "e16", text: "Ada" }, { action: "page_select", ref: "e19", option: "Billing" }, { action: "page_click", ref: "e25" }] });
    expect(result.isError).not.toBe(true);
    expect(result.content.map((part) => part.type)).toEqual(["text", "text"]);
    expect((result.content[1] as { text: string }).text).toContain("Page: Contact us");
  });

  it("stops at the first step that fails, says which and what was done, and runs nothing after it", async () => {
    const box = computer((command) => command.includes("key --clearmodifiers 'F13'"));
    const result = await run(off, { steps: [{ action: "click", x: 1, y: 1 }, { action: "key", key: "F13" }, { action: "type", text: "never" }] }, box);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("Step 2 of 3 (key F13) failed: {\"ok\":false,\"exitCode\":1,\"stdout\":\"\",\"stderr\":\"xdotool: no window\"}. Done before it: click 1,1. Nothing after it ran.");
    expect(box.commands.some((command) => command.includes("xclip"))).toBe(false);
  });

  it("checks every step before running any, so a half-written run does nothing", async () => {
    const box = computer();
    const result = await run(off, { steps: [{ action: "click", x: 1, y: 1 }, { action: "click", x: 5 }] }, box);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^Step 2 \(click\) is not complete: .* Nothing ran\.$/);
    expect(box.commands).toEqual([]);
  });

  it.each([
    ["a secure field", { action: "fill_secure_field", field: "password" }],
    ["a command", { action: "exec", command: "cat ~/.ssh/id_rsa" }],
    ["a vault item on a typing step", { action: "type", text: "x", vault: [{ name: "site/password", as: "stdin" }] }],
    ["a secure form request", { action: "request_secure_form" }],
  ])("refuses %s, so a run is no way around the secure tools", async (_, step) => {
    const box = computer();
    const result = await run(on, { steps: [{ action: "click", x: 1, y: 1 }, step] }, box);
    expect(result.isError).toBe(true);
    expect(box.commands).toEqual([]);
  });

  it("refuses page steps while the page tools are off", async () => {
    const box = computer();
    const result = await run(off, { steps: [{ action: "page_click", ref: "e3" }] }, box);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Step 1 (page_click) needs the page tools, which are not offered here. Nothing ran." }] });
    expect(box.commands).toEqual([]);
  });

  it("ends a wait at once when the turn is stopped, and runs nothing after it", async () => {
    const box = computer();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    const outcome = await runCloudComputerTool(off, "box", "run_actions", { steps: [{ action: "wait", ms: 5000 }, { action: "key", key: "Return" }] }, stop.signal, undefined, undefined, box.exec)
      .then(() => "finished", (error: Error) => error.name);
    expect(outcome).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(box.commands).toEqual([]);
  });
});
