import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CLOUD_COMPUTER_TOOLS, computerToolsFor, runCloudComputerTool } from "../cloud-computer-tools.ts";
import type { AppConfig } from "../config.ts";
import { computerPrompt } from "../system-prompt.ts";
import { PAGE_TOOLS, pageAgentCommand, pageAgentInput, pageToolsEnabled, runPageAgent, runPageTool, type RemoteExec } from "./page-tools.ts";

const off = {} as AppConfig;
const on = { features: { pageTools: true } } as AppConfig;
const signal = new AbortController().signal;
const answering = (stdout: string, seen: string[] = []): RemoteExec => async (command) => {
  seen.push(command);
  return { ok: true, exitCode: 0, stdout, stderr: "" };
};

describe("page tools on the cloud computer's own browser", () => {
  it("are not offered and refuse a call while the browser switch is off", async () => {
    expect(computerToolsFor(off)).toBe(CLOUD_COMPUTER_TOOLS);
    const seen: string[] = [];
    const result = await runCloudComputerTool(off, "box", "page_read", {}, signal, undefined, undefined, answering("{}", seen));
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("stay off for a home that saved the old in-app browser switch, which earlier versions wrote", async () => {
    const old = { features: { browser: true } } as AppConfig;
    expect(computerToolsFor(old)).toBe(CLOUD_COMPUTER_TOOLS);
    const seen: string[] = [];
    const result = await runCloudComputerTool(old, "box", "page_read", {}, signal, undefined, undefined, answering("{}", seen));
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
    expect(computerPrompt("box", { pageTools: pageToolsEnabled(old) })).toBe(computerPrompt("box"));
    expect(pageToolsEnabled(on)).toBe(true);
  });

  it("are offered next to the screen tools when the switch is on, and stay small", () => {
    expect(computerToolsFor(on).map((entry) => entry.name)).toEqual([...CLOUD_COMPUTER_TOOLS, ...PAGE_TOOLS].map((entry) => entry.name));
    expect(PAGE_TOOLS.map((entry) => entry.name)).toEqual(["page_open", "page_read", "page_click", "page_fill", "page_select", "page_press", "page_back", "page_text"]);
    expect(Buffer.byteLength(JSON.stringify(PAGE_TOOLS))).toBeLessThan(2_600);
  });

  it("send one self-contained command to the computer and pass its answer back", async () => {
    const seen: string[] = [];
    const read = await runCloudComputerTool(on, "box", "page_read", { selector: "main" }, signal, undefined, undefined, answering(JSON.stringify({ ok: true, text: "Page: Shop" }), seen));
    expect(read).toEqual({ content: [{ type: "text", text: "Page: Shop" }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(pageAgentCommand(pageAgentInput("page_read", { selector: "main" })));
    const missing = await runPageTool(answering(JSON.stringify({ ok: false, error: "No element e9 on this page; read the page again." })), "page_click", { ref: "e9" }, signal);
    expect(missing).toEqual({ isError: true, content: [{ type: "text", text: "No element e9 on this page; read the page again." }] });
    const silent = await runPageTool(async () => ({ ok: false, exitCode: 127, stdout: "", stderr: "node: not found" }), "page_read", {}, signal);
    expect(silent.isError).toBe(true);
    expect(silent.content[0]!.text).toContain("node: not found");
  });

  it("open a page in the dog's own tab, beside it only when asked, and say which tab they used", async () => {
    const choice = { target: "MINE0001", avoid: ["PERSON01"] };
    expect(pageAgentInput("page_open", { url: "https://shop.test/" }, choice)).toMatchObject({ action: "open", url: "https://shop.test/", target: "MINE0001", avoid: ["PERSON01"] });
    expect(pageAgentInput("page_open", { url: "https://shop.test/" }, choice).fresh).toBeUndefined();
    expect(pageAgentInput("page_open", { url: "https://shop.test/", new_tab: true }, choice)).toMatchObject({ fresh: true });
    expect(pageAgentInput("page_read", {}, choice)).not.toHaveProperty("target");
    const opened = await runPageAgent(answering(JSON.stringify({ ok: true, text: "Page: Shop", tab: "MINE0001", opened: false })), "page_open", { url: "https://shop.test/" }, signal, choice);
    expect(opened).toEqual({ result: { content: [{ type: "text", text: "Page: Shop" }] }, tab: "MINE0001" });
    const forged = await runPageAgent(answering(JSON.stringify({ ok: true, text: "Page: Shop", tab: "x; rm -rf /" })), "page_open", { url: "https://shop.test/" }, signal);
    expect(forged.tab).toBeUndefined();
  });

  it("refuse arguments outside their schema, such as a made-up ref", async () => {
    for (const [name, args] of [["page_click", { ref: "#login" }], ["page_open", { url: "file:///etc/passwd" }], ["page_fill", { ref: "e1", text: "x", vault: [] }]] as const) {
      const result = await runCloudComputerTool(on, "box", name, args, signal, undefined, undefined, answering("{}"));
      expect([name, result.isError]).toEqual([name, true]);
    }
  });

  it("tell a dog to read the page first only while the switch is on, and leave the instructions byte for byte otherwise", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(sha(computerPrompt("box"))).toBe("0c6978f3aa34968697f9d99806c34f1be4d70acedec689e00f2867d07f5507da");
    expect(computerPrompt("box", { pageTools: false })).toBe(computerPrompt("box"));
    expect(computerPrompt("local", { pageTools: true })).toBe(computerPrompt("local"));
    const steered = computerPrompt("box", { pageTools: true });
    expect(steered).toContain("read its structure with page_open and page_read");
    expect(steered).toContain("take a screenshot only when the structure does not show what you need");
    expect(steered.startsWith(computerPrompt("box").slice(0, 120))).toBe(true);
  });
});
