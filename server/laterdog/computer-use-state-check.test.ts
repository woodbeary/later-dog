import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { doneRuleSchema } from "./computer-use-done.ts";
import { DEVTOOLS_PORT, readStateCheck, STATE_CHECK_SCRIPT, STATE_SCRIPT_PATH, stateCheckCommand } from "./computer-use-state-check.ts";

const RULE = { url: "https://portal.clinic.example/requests/", contains: "Request received" };
const PAGE_TEXT = "Request received. Reference 42. Interpreter: Thursday 2 pm.";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function fakeDevtools(pages: Array<{ title: string; url: string; text: string }>) {
  const origins: Array<string | undefined> = [];
  const server: Server = createServer((request, response) => {
    if (request.url !== "/json/list") { response.writeHead(404).end(); return; }
    const port = (server.address() as { port: number }).port;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ type: "service_worker", title: "worker", url: "https://x.example/sw.js", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/sw` },
      ...pages.map((page, index) => ({ type: "page", title: page.title, url: page.url, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${index}` }))]));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    origins.push(request.headers.origin);
    if (request.headers.origin) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const page = pages[Number(request.url!.split("/").at(-1))]!;
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        ws.send(JSON.stringify({ id: message.id, result: { result: { type: "string", value: JSON.stringify({ url: page.url, text: page.text }) } } }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(async () => { sockets.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { port: (server.address() as { port: number }).port, origins };
}

async function runScript(port: number, windowName: string, rule = RULE): Promise<{ code: number; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-state-check-"));
  closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state-check.mjs");
  writeFileSync(file, STATE_CHECK_SCRIPT);
  const args = [file, Buffer.from(JSON.stringify(rule)).toString("base64"), Buffer.from(windowName).toString("base64")];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env: { ...process.env, LATERDOG_DEVTOOLS_PORT: String(port) }, timeout: 15_000 }, (error, stdout) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout });
    });
  });
}

describe("the state check on the desktop's own browser", () => {
  it("reads the active tab over the local DevTools port with no Origin header, and gives back the address without the page's text", async () => {
    const devtools = await fakeDevtools([
      { title: "Inbox", url: "https://mail.example/inbox", text: "Request received in another tab" },
      { title: "Request 42 - Clinic portal", url: "https://portal.clinic.example/requests/42?session=fixture-token", text: PAGE_TEXT },
    ]);
    const ran = await runScript(devtools.port, "Request 42 - Clinic portal - Chromium");
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ where: "https://portal.clinic.example/requests/42", urlMatches: true, textMatches: true, active: true });
    expect(ran.stdout).not.toContain("Interpreter");
    expect(ran.stdout).not.toContain("fixture-token");
    expect(devtools.origins).toEqual([undefined]);
    expect(readStateCheck(0, ran.stdout)).toEqual({ passed: true, detail: "The active tab is on https://portal.clinic.example/requests/42 and shows the expected text." });
  });

  it("does not pass a page without the text, at another address, or a tab it cannot tell is the active one", async () => {
    const devtools = await fakeDevtools([
      { title: "New request - Clinic portal", url: "https://portal.clinic.example/requests/new", text: "Fill in the form" },
      { title: "Other", url: "https://portal.clinic.example/requests/9", text: PAGE_TEXT },
    ]);
    expect(readStateCheck(0, (await runScript(devtools.port, "New request - Clinic portal - Chromium")).stdout))
      .toEqual({ passed: false, detail: "The active tab is on https://portal.clinic.example/requests/new; the expected text is not on the page." });
    expect(readStateCheck(0, (await runScript(devtools.port, "New request - Clinic portal - Chromium", { url: "https://elsewhere.example/", contains: "Fill" })).stdout))
      .toEqual({ passed: false, detail: "The active tab is on https://portal.clinic.example/requests/new, not the expected address." });
    expect(readStateCheck(0, (await runScript(devtools.port, "Terminal", { url: "https://portal.clinic.example/requests/", contains: "Fill in" })).stdout)).toEqual({
      passed: false, detail: "A tab (the active one could not be told apart) is on https://portal.clinic.example/requests/new and shows the expected text, so the person decides." });
  });

  it("says plainly when there is no DevTools port, and when the check did not run", async () => {
    const closed = createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const ran = await runScript(port, "anything");
    expect(readStateCheck(0, ran.stdout)).toEqual({ passed: false, detail: "The desktop's browser has no local DevTools port, so the state check could not read it." });
    expect(readStateCheck(127, "")).toEqual({ passed: false, detail: "The state check did not run on the desktop." });
    expect(readStateCheck(0, "not json").passed).toBe(false);
  });

  it("ships the script as base64 and passes the rule and the window title without shell quoting trouble", () => {
    const command = stateCheckCommand({ url: "https://x.example/'; rm -rf ~ #", contains: "it's done" });
    expect(command).toContain(`> ${STATE_SCRIPT_PATH} && node ${STATE_SCRIPT_PATH} '`);
    expect(command).not.toContain("rm -rf");
    expect(command).toContain(`"$(xdotool getactivewindow getwindowname 2>/dev/null | head -c 1000 | base64 -w0)"`);
  });

  it("takes a state check in the done rule only with an https address and text", () => {
    expect(doneRuleSchema.parse({ pageCheck: null, stateCheck: RULE })).toEqual({ pageCheck: null, stateCheck: RULE });
    expect(() => doneRuleSchema.parse({ pageCheck: null, stateCheck: { url: "http://portal.clinic.example/", contains: "x" } })).toThrow();
    expect(() => doneRuleSchema.parse({ pageCheck: null, stateCheck: { url: RULE.url, contains: " " } })).toThrow();
    expect(doneRuleSchema.parse({ pageCheck: null })).toEqual({ pageCheck: null });
  });

  it("matches the computers image: Chromium opens DevTools on loopback only, and its own pages cannot open that port", () => {
    const container = new URL("../../deploy/laterdog/computers/container/", import.meta.url);
    const flags = readFileSync(new URL("chromium-flags", container), "utf8");
    expect(flags).toContain(`--remote-debugging-port=${DEVTOOLS_PORT} --remote-debugging-address=127.0.0.1`);
    expect(flags).not.toContain("--remote-allow-origins");
    const policy = JSON.parse(readFileSync(new URL("chromium-policy.json", container), "utf8")) as Record<string, unknown>;
    expect(policy.URLBlocklist).toEqual([`127.0.0.1:${DEVTOOLS_PORT}`, `localhost:${DEVTOOLS_PORT}`, `0.0.0.0:${DEVTOOLS_PORT}`]);
    expect(policy.DeveloperToolsAvailability).toBeUndefined();
  });
});
