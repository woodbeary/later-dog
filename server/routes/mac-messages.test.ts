import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { MAC_MESSAGES_WORDS, READ_TEXTS_PATH, SEND_EMAIL_PATH, SEND_TEXT_PATH, type MacAsk, type MessagesMac } from "../laterdog/mac-messages.ts";
import type { SharedComputerOperation } from "../shared-computers.ts";
import type { BotRecord } from "../store.ts";
import { MAC_NEVER } from "../mac-approval.ts";
import { dispatchInternalRoutes } from "./internal.ts";
import { createMacMessagesRoute } from "./mac-messages.ts";

const SENDER = { id: "dog-olive", name: "Olive" } as BotRecord;
const MAC_ID = "6f1c1d1e-1111-4222-8333-444455556666";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve(options: { enabled?: boolean; active?: boolean; macError?: Error; output?: string; never?: boolean } = {}) {
  const asked: MacAsk[] = [];
  const picked: (string | undefined)[] = [];
  const ran: SharedComputerOperation[] = [];
  const mac: MessagesMac = {
    name: "Jo's MacBook Air",
    never: options.never ?? false,
    approve: async (ask) => { asked.push(ask); },
    active: () => true,
    run: async (operation) => {
      ran.push(operation);
      return { content: [{ type: "text", text: JSON.stringify({ command_id: "c1", running: false, exitCode: 0, output: options.output ?? "iMessage" }) }] };
    },
  };
  const route = createMacMessagesRoute({
    enabled: () => options.enabled ?? true,
    active: () => options.active ?? true,
    mac: async (_capability, computerId) => {
      picked.push(computerId);
      if (options.macError) throw options.macError;
      return mac;
    },
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchInternalRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", json, sender: SENDER, threadId: "main", capability: {}, readBody: () => readBody(req) })) return;
    json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { post, asked, picked, ran };
}

describe("the routes a dog uses for texts and email on the Mac", () => {
  it("sends a text on the Mac it names, after the card, and tells the dog how it went", async () => {
    const { post, asked, picked, ran } = await serve();
    const answer = await post(SEND_TEXT_PATH, { to: "+1 555 123 4567", text: "Running late", computer_id: MAC_ID });
    expect(answer).toEqual({ status: 200, body: { text: MAC_MESSAGES_WORDS.sentText("+15551234567", "iMessage", "Jo's MacBook Air") } });
    expect(picked).toEqual([MAC_ID]);
    expect(asked).toEqual([{ action: "send_text", arguments: { to: "+15551234567", text: "Running late" } }]);
    expect(ran[0]?.action).toBe("run_command");
  });

  it("sends an email and reads texts through the same Mac", async () => {
    const email = await serve({ output: "sent" });
    expect((await email.post(SEND_EMAIL_PATH, { to: ["sam@example.com"], subject: "Friday", body: "See you." })).body)
      .toEqual({ text: MAC_MESSAGES_WORDS.sentEmail(["sam@example.com"], "Jo's MacBook Air") });
    const texts = await serve({ output: "" });
    expect(await texts.post(READ_TEXTS_PATH, { since: "2026-10-29" })).toEqual({ status: 200, body: { texts: [], note: MAC_MESSAGES_WORDS.noTexts } });
    expect(texts.asked).toEqual([{ action: "read_texts", arguments: { since: "2026-10-29" } }]);
  });

  it("refuses a bad request, an expired turn and a home without a lent Mac, and passes on why the Mac can't be used", async () => {
    const bad = await (await serve()).post(SEND_TEXT_PATH, { to: "+15551234567" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/^Nothing was sent\. Check the request: text: /);
    expect(String((await (await serve()).post(READ_TEXTS_PATH, { since: "soon" })).body.error)).toMatch(/^Check the request: since: /);
    expect((await (await serve({ active: false })).post(SEND_TEXT_PATH, { to: "+15551234567", text: "hi" })).status).toBe(401);
    expect(await (await serve({ enabled: false })).post(SEND_TEXT_PATH, { to: "+15551234567", text: "hi" })).toEqual({ status: 404, body: { from: "inline routes" } });
    const offline = await serve({ macError: Object.assign(new Error("Jo's MacBook Air is offline."), { status: 409 }) });
    expect(await offline.post(READ_TEXTS_PATH, {})).toEqual({ status: 409, body: { error: "Jo's MacBook Air is offline." } });
    expect(offline.asked).toEqual([]);
  });

  it("runs nothing at all on a Mac set to Never, not even a Contacts lookup", async () => {
    const never = await serve({ never: true });
    for (const [path, body] of [[SEND_TEXT_PATH, { to: "Sam", text: "hi" }], [READ_TEXTS_PATH, {}], [SEND_EMAIL_PATH, { to: ["sam@example.com"], subject: "s", body: "b" }]] as const) {
      expect(await never.post(path, body)).toEqual({ status: 403, body: { error: MAC_NEVER } });
    }
    expect(never.ran).toEqual([]);
    expect(never.asked).toEqual([]);
  });
});
