import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog, type VerificationServer } from "../scripts/control-laterdog.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("a repeated send is answered before spend and task refusals", () => {
  let session: VerificationServer;
  let layerDir: string;

  beforeEach(async () => {
    layerDir = mkdtempSync(join(tmpdir(), "laterdog-fake-layer-"));
    mkdirSync(join(layerDir, "server"));
    writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Co", features: ["budgets", "billing"], expiresAt: "2099-01-01" }; }\n');
    session = await launchVerificationServer(process.env, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
  }, 60_000);

  afterEach(async () => {
    console.info(JSON.stringify(session.info));
    await session.close();
    await removeTempDir(layerDir);
  });

  const control = (args: string[]) => runControlLaterDog([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, init: RequestInit = {}) => fetch(`${session.info.url}${path}`, init);
  const post = (path: string, body: unknown) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const put = (body: unknown) => api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rowsWith = async (threadId: string, sendId: string) => {
    const page = await (await api(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=50`)).json() as any;
    return page.messages.filter((message: any) => message.sendId === sendId);
  };

  it("returns the landed row after the cap trips, keeps the 409 for a changed text, and refuses new messages on the dog and room routes", async () => {
    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    const dog = (await control(["new-bot", "--name", "Landed dog"])).bot;
    const lead = (await control(["new-bot", "--name", "Room lead"])).bot;
    const member = (await control(["new-bot", "--name", "Room member"])).bot;
    const created = await post("/api/groups", {
      name: "Landed room", memberIds: [lead.id, member.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    expect(created.status).toBe(201);
    const { group } = await created.json() as any;

    const dogPath = `/api/bots/${encodeURIComponent(dog.id)}/messages`;
    const roomPath = `/api/groups/${encodeURIComponent(group.id)}/messages`;
    const dogSendId = "landed_dog_send_0001";
    const roomSendId = "landed_room_send_0001";

    const dogFirst = await post(dogPath, { text: "first words", sendId: dogSendId });
    expect(dogFirst.status).toBe(202);
    const dogReceipt = await dogFirst.json() as any;
    expect(dogReceipt.message).toMatchObject({ sendId: dogSendId, text: "first words" });
    expect(JSON.stringify(await control(["wait", "--bot", dog.id, "--timeout", "30"]))).toContain("settled");

    const roomFirst = await post(roomPath, { text: "hello room", sendId: roomSendId });
    expect(roomFirst.status).toBe(202);
    const roomReceipt = await roomFirst.json() as any;
    expect(roomReceipt.message).toMatchObject({ sendId: roomSendId, text: "hello room" });
    await control(["wait", "--channel", group.id, "--timeout", "30"]);

    expect((await put({ budgets: { monthlyUsd: 0.01 } })).status).toBe(200);
    await expect.poll(async () => (await (await api("/api/usage")).json() as any).budget?.exceeded, { timeout: 10_000 }).toBe(true);

    for (const route of [
      { path: dogPath, sendId: dogSendId, text: "first words", receipt: dogReceipt, threadId: dogReceipt.threadId as string },
      { path: roomPath, sendId: roomSendId, text: "hello room", receipt: roomReceipt, threadId: roomReceipt.threadId as string },
    ]) {
      const resent = await post(route.path, { text: route.text, sendId: route.sendId });
      expect(resent.status).toBe(202);
      expect(await resent.json()).toMatchObject({ ok: true, threadId: route.threadId, message: { id: route.receipt.message.id, sendId: route.sendId } });

      const changed = await post(route.path, { text: `${route.text} changed`, sendId: route.sendId });
      expect(changed.status).toBe(409);
      const changedBody = await changed.json() as any;
      expect(changedBody.error).toMatch(/another message/);
      expect(changedBody.code).toBeUndefined();

      const fresh = await post(route.path, { text: "a new message", sendId: `${route.sendId}_new` });
      expect(fresh.status).toBe(409);
      expect(await fresh.json()).toMatchObject({ code: "spend_cap" });

      const unnamed = await post(route.path, { text: "another new message" });
      expect(unnamed.status).toBe(409);
      expect(await unnamed.json()).toMatchObject({ code: "spend_cap" });

      expect(await rowsWith(route.threadId, route.sendId)).toHaveLength(1);
      expect(await rowsWith(route.threadId, `${route.sendId}_new`)).toHaveLength(0);
    }
  }, 150_000);
});
