import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCloudComputerTool } from "../../server/cloud-computer-tools.ts";
import type { AppConfig } from "../../server/config.ts";
import { startFixtureSite } from "./fixture-site.ts";
import { headlessBrowser, refIn, type HeadlessBrowser } from "./no-vision.ts";

const SECRETS = { email: "ada.secret@example.test", password: "S3cret-pass!", code: "482913", card: "4111111111111111", notes: "private note 7731", diary: "dear diary 5521", address: "12 Hidden Lane" };
const MIRRORED = { tags: "tagsecret222", bio: "biosecret333" };
const cfg = { features: { pageTools: true } } as AppConfig;
const signal = new AbortController().signal;

async function typeInto(port: number, values: Record<string, string>): Promise<void> {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(pages.find((page) => page.type === "page")!.webSocketDebuggerUrl);
  await new Promise((ready, fail) => { socket.addEventListener("open", ready); socket.addEventListener("error", fail); });
  let next = 0;
  const send = (method: string, params: Record<string, unknown>) => new Promise((done) => {
    const id = ++next;
    const listen = (event: MessageEvent) => { if (JSON.parse(String(event.data)).id === id) { socket.removeEventListener("message", listen); done(undefined); } };
    socket.addEventListener("message", listen);
    socket.send(JSON.stringify({ id, method, params }));
  });
  for (const [id, value] of Object.entries(values)) {
    await send("Runtime.evaluate", { expression: `document.getElementById(${JSON.stringify(id)}).focus()` });
    await send("Input.insertText", { text: value });
  }
  socket.close();
}

describe.skipIf(!headlessBrowser.available())("what the page tools show after a Secure Form typed into a page", () => {
  let chrome: HeadlessBrowser;
  let site: Awaited<ReturnType<typeof startFixtureSite>>;
  beforeAll(async () => { chrome = await headlessBrowser.start(); site = await startFixtureSite(); }, 30_000);
  afterAll(async () => { await site?.close(); await chrome?.stop(); });

  it("never holds a typed value, and never a password, in any page tool result or a run's reading", async () => {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await runCloudComputerTool(cfg, "fixture", name, args, signal, undefined, undefined, chrome.exec);
      return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    };
    const opened = await call("page_open", { url: `${site.origin}/secure` });
    await typeInto(chrome.port, { ...SECRETS, ...MIRRORED });
    const leaks = (index: number, text: string) => {
      for (const [name, value] of Object.entries({ ...SECRETS, ...MIRRORED })) expect([index, name, text.includes(value)]).toEqual([index, name, false]);
    };
    const read = await call("page_read");
    leaks(0, read);
    const steps: Array<() => Promise<string>> = [
      () => call("page_read", { selector: "form" }),
      ...["Email", "One-time code", "Card number"].map((label) => () => call("page_text", { ref: refIn(opened, "textbox", label) })),
      () => call("page_text", { ref: refIn(opened, "password", "Password") }),
      () => call("page_text", { selector: "input[type=password]" }),
      () => call("page_text", { selector: "#code" }),
      () => call("page_text", { selector: "form" }),
      () => call("page_text", { selector: "body" }),
      () => call("page_text", { selector: "label[for=bio]" }),
      () => call("run_actions", { steps: [{ action: "wait", ms: 0 }], reading: "page" }),
      () => call("page_text", { ref: refIn(read, "textbox", "Notes") }),
      () => call("page_text", { ref: refIn(read, "textbox", "Diary") }),
    ];
    for (const [index, step] of steps.entries()) leaks(index + 1, await step());
    expect(read).toMatch(/textbox "Email" \(filled\)/);
    expect(read).toMatch(/password "Password" \(filled\)/);
    expect(read).toMatch(/textbox "Card number" \(filled\)/);
  }, 60_000);

  it("never names a field with a value the page mirrored into hidden text inside its label", async () => {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await runCloudComputerTool(cfg, "fixture", name, args, signal, undefined, undefined, chrome.exec);
      return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    };
    await call("page_open", { url: `${site.origin}/secure` });
    await typeInto(chrome.port, MIRRORED);
    for (const text of [await call("page_read"), await call("page_read", { selector: "form" }), await call("run_actions", { steps: [{ action: "wait", ms: 0 }], reading: "page" })]) {
      for (const [name, value] of Object.entries(MIRRORED)) expect([name, text.includes(value)]).toEqual([name, false]);
      expect(text).toMatch(/textbox "Tags" \(filled\)/);
      expect(text).toMatch(/textbox "Bio" \(filled\)/);
    }
  }, 60_000);
});
