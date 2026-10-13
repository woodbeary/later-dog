import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import type { SecureFormDesk } from "./laterdog/secure-form.ts";

const jpeg = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==";
let server: Server;
let tools: typeof import("./cloud-computer-tools.ts");
let holdCommand = false;
let commandReply: Record<string, unknown> = {};
let commandStarted: (() => void) | undefined;
const calls: Array<{ path: string; body: any; authorization?: string }> = [];
const cfg: AppConfig = { box: { token: "synthetic-box-key" } } as AppConfig;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const path = req.url ?? "";
    calls.push({ path, body: body ? JSON.parse(body) : null, authorization: req.headers.authorization });
    if (path.endsWith("/commands")) {
      commandStarted?.();
      if (!holdCommand) res.end(JSON.stringify(commandReply));
      return;
    }
    if (path.includes("/artifacts?")) { res.end(Buffer.from(jpeg, "base64")); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  vi.stubEnv("LATERDOG_BOX_API", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("LATERDOG_CLOUD_BOAT_TOKEN", undefined);
  tools = await import("./cloud-computer-tools.ts");
});
beforeEach(() => { calls.length = 0; holdCommand = false; commandStarted = undefined; commandReply = { exitCode: 0, stdout: "captured", stderr: "" }; });
afterAll(async () => { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

const rpc = (request: unknown, gate: { held: boolean; blockedReason?: string } = { held: false }, signal = new AbortController().signal, secureForms?: SecureFormDesk) => {
  let gated = 0;
  let checks = 0;
  const done = tools.cloudComputerRpc(request as never, {
    cfg, boxId: () => "bx_23456789", signal,
    gate: async () => { gated++; return gate; },
    assertActive: () => { checks++; },
    secureForms,
  });
  return { done, gated: () => gated, checks: () => checks };
};

describe("cloud computer tools", () => {
  it("lists the same twelve tools for every engine", async () => {
    const listed = await rpc({ method: "tools/list", params: {} }).done as { tools: Array<{ name: string }> };
    expect(listed.tools.map(tool => tool.name)).toEqual([
      "screenshot", "get_screen_size", "click", "move", "drag", "type_text", "key_press", "scroll", "open_url", "exec",
      "request_secure_form", "fill_secure_field",
    ]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["click", { x: 3, y: 4, button: "right", count: 2 }, "click --repeat 2 --delay 100 3"],
    ["move", { x: 7, y: 8 }, "mousemove --sync 7 8"],
    ["drag", { x: 1, y: 2, to_x: 3, to_y: 4 }, "mousedown 1 mousemove --sync 3 4 mouseup 1"],
    ["scroll", { x: 4, y: 3, direction: "down", amount: 2 }, "click --repeat 2 --delay 80 5"],
    ["key_press", { key: "ctrl+l" }, "key --clearmodifiers"],
    ["type_text", { text: "Unicode: 日本語 ' $(echo unsafe)" }, "base64 -d | xclip"],
    ["open_url", { url: "https://example.com/?a='&b=2" }, "xdg-open"],
    ["exec", { command: "printf hello" }, "printf hello"],
    ["get_screen_size", {}, "getdisplaygeometry"],
  ] as const)("runs %s on the assigned Boat only, with the server's own account", async (name, args, expected) => {
    const call = rpc({ method: "tools/call", params: { name, arguments: args } });
    const result = await call.done as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).not.toBe(true);
    if (name === "open_url") expect(result.content[0].text).toContain("Page loading is not confirmed");
    expect(call.gated()).toBe(1);
    expect(call.checks()).toBe(2);
    expect(calls.map(entry => entry.path)).toEqual(["/boxes/bx_23456789/commands"]);
    expect(calls[0].authorization).toBe("Bearer synthetic-box-key");
    expect(calls[0].body.command).toContain("exec env -i");
    expect(calls[0].body.command).toContain(expected);
    expect(calls[0].body.command).not.toContain("synthetic-box-key");
    if (name === "type_text") expect(calls[0].body.command).not.toContain("$(echo unsafe)");
  });

  it("returns native-size screenshots as MCP images", async () => {
    const result = await rpc({ method: "tools/call", params: { name: "screenshot", arguments: {} } }).done;
    expect(result).toEqual({ content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from(jpeg, "base64").toString("base64") }] });
    expect(calls[0].body.command).toContain("laterdog-panel.jpg.model.jpg");
    expect(calls[0].body.command).not.toContain("-resize");
    expect(calls[1].path).toContain("laterdog-panel.jpg.model.jpg");
  });

  it.each([
    ["a shell fragment in a coordinate", "click", { x: "1; touch marker", y: 4 }],
    ["a file URL", "open_url", { url: "file:///etc/passwd" }],
    ["an extra field", "move", { x: 1, y: 2, after: "rm -rf /" }],
    ["a key with shell syntax", "key_press", { key: "a; reboot" }],
    ["an unknown tool", "computer_exec", { command: "true" }],
    ["non-object arguments", "exec", "true"],
  ])("refuses %s before the control gate or the Boat", async (_label, name, args) => {
    const call = rpc({ method: "tools/call", params: { name, arguments: args } });
    const result = await call.done as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/input schema|Unknown cloud computer tool/);
    expect(call.gated()).toBe(0);
    expect(calls).toHaveLength(0);
    await expect(tools.runCloudComputerTool(cfg, "bx_23456789", name, args as never, new AbortController().signal))
      .resolves.toMatchObject({ isError: true });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a person holds control", { held: true }, "NOT performed"],
    ["another thread owns the seat", { held: true, blockedReason: "Another thread is using this computer." }, "Another thread is using this computer."],
  ])("performs nothing on the Boat when %s", async (_label, gate, text) => {
    const call = rpc({ method: "tools/call", params: { name: "click", arguments: { x: 3, y: 4 } } }, gate);
    const result = await call.done as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(text);
    expect(calls).toHaveLength(0);
  });

  it("acts on the Boat the gate started, read only once the gate let the call through", async () => {
    let started: string | undefined;
    const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "get_screen_size", arguments: {} } }, {
      cfg, boxId: () => started, signal: new AbortController().signal,
      gate: async () => { started = "bx_3456789a"; return { held: false }; }, assertActive: () => {},
    }) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(calls.map(entry => entry.path)).toEqual(["/boxes/bx_3456789a/commands"]);
  });

  it("performs nothing when the gate let a call through and no Boat landed", async () => {
    const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "true" } } }, {
      cfg, boxId: () => null, signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: () => {},
    }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: tools.CLOUD_COMPUTER_NOT_READY }] });
    expect(calls).toHaveLength(0);
  });

  it("stops when the turn's capability is gone, before and after the Boat acts", async () => {
    const expired = () => { throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 }); };
    await expect(tools.cloudComputerRpc({ method: "tools/list" }, {
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: expired,
    })).rejects.toThrow("expired");
    await expect(tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "true" } } }, {
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: expired,
    })).rejects.toThrow("expired");
    expect(calls).toHaveLength(0);
    await expect(rpc({ method: "resources/read" }).done).rejects.toMatchObject({ status: 400 });
  });

  describe("Secure Forms", () => {
    const SECURE_FORMS_UNAVAILABLE = "Secure Forms are not available in this conversation. Ask the person with request_takeover instead.";
    const request = (site: string) => ({
      method: "tools/call",
      params: { name: "request_secure_form", arguments: { title: "Sign in to Example", site, fields: [{ id: "password", label: "Password", type: "password" }] } },
    });
    const fill = { method: "tools/call", params: { name: "fill_secure_field", arguments: { form_id: "form-1", field_id: "password", x: 640, y: 400, submit: true } } };
    const desk = (value = "correct horse 'battery' $(staple)") => ({
      open: vi.fn<SecureFormDesk["open"]>(() => ({ formId: "form-1" })),
      field: vi.fn<SecureFormDesk["field"]>(() => ({ ok: true, host: "example.com", label: "Password", value })),
      typed: vi.fn<SecureFormDesk["typed"]>(() => ({ last: true })),
    });

    it("opens a form without the control gate or the Boat", async () => {
      const forms = desk();
      const call = rpc(request("https://www.example.com/login"), { held: true }, undefined, forms);
      const result = await call.done as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain("form_id \"form-1\"");
      expect(forms.open).toHaveBeenCalledWith({ title: "Sign in to Example", host: "example.com", fields: [{ id: "password", label: "Password", type: "password" }] });
      expect(call.gated()).toBe(0);
      expect(call.checks()).toBe(1);
      expect(calls).toEqual([]);
    });

    it("refuses a form where the conversation cannot show one, or for a shared address", async () => {
      expect(await rpc(request("example.com")).done).toEqual({ isError: true, content: [{ type: "text", text: SECURE_FORMS_UNAVAILABLE }] });
      const forms = desk();
      expect(await rpc(request("github.io"), { held: false }, undefined, forms).done)
        .toMatchObject({ isError: true, content: [{ text: expect.stringContaining("shared by many sites") }] });
      expect(forms.open).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it("types a value through the gate as base64 and never reports it back", async () => {
      const forms = desk();
      const call = rpc(fill, { held: false }, undefined, forms);
      const result = await call.done as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain("Typed Password into the page on example.com and pressed Enter.");
      expect(JSON.stringify(result)).not.toMatch(/captured|staple/);
      expect(call.gated()).toBe(1);
      expect(calls.map(entry => entry.path)).toEqual(["/boxes/bx_23456789/commands"]);
      expect(calls[0].body.command).toContain("exec env -i");
      expect(calls[0].body.command).toContain(Buffer.from("correct horse 'battery' $(staple)").toString("base64"));
      expect(calls[0].body.command).not.toContain("staple");
      expect(forms.typed).toHaveBeenCalledWith("form-1", "password");
    });

    it("types nothing while a person holds the computer or the conversation has no forms", async () => {
      const forms = desk();
      expect(await rpc(fill, { held: true }, undefined, forms).done).toMatchObject({ isError: true });
      expect(forms.field).not.toHaveBeenCalled();
      expect(await rpc(fill).done).toEqual({ isError: true, content: [{ type: "text", text: SECURE_FORMS_UNAVAILABLE }] });
      expect(calls).toEqual([]);
    });

    it("tells the dog why a value was not typed, without counting it", async () => {
      commandReply = { exitCode: 7, stdout: "HOST=evil.test\n", stderr: "" };
      const forms = desk();
      const result = await rpc(fill, { held: false }, undefined, forms).done as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("The browser is on evil.test, not example.com, so nothing was typed.");
      expect(forms.typed).not.toHaveBeenCalled();
    });
  });

  it("aborts an in-flight Boat command without retrying it", async () => {
    holdCommand = true;
    const started = new Promise<void>(resolve => { commandStarted = resolve; });
    const abort = new AbortController();
    const running = rpc({ method: "tools/call", params: { name: "exec", arguments: { command: "printf fixture" } } }, { held: false }, abort.signal).done;
    const rejected = expect(running).rejects.toThrow();
    await started;
    abort.abort();
    await rejected;
    expect(calls.filter(entry => entry.path.endsWith("/commands"))).toHaveLength(1);
    server.closeAllConnections();
  });
});
