import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { BotRecord } from "../store.ts";
import { json, readBody } from "../harness/http.ts";
import { PlanStore, type PlanCaller } from "../laterdog/dog-plan.ts";
import { dispatchInternalRoutes } from "./internal.ts";
import { createPlanRoute, HELPER_PLAN_TEXT, PLAN_PATH } from "./dog-plan.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(callers: Record<string, PlanCaller> = {}, shown = true) {
  const plans = new PlanStore(null, () => 7);
  const changed: string[] = [];
  const routes = [createPlanRoute({
    set: (threadId, items, botId) => plans.set(threadId, items, botId),
    caller: async (toolUseId) => (toolUseId && callers[toolUseId]) || "dog",
    changed: (threadId) => changed.push(threadId),
    shown: () => shown,
    active: () => true,
  })];
  const server = createServer(async (req, res) => {
    const handled = await dispatchInternalRoutes(routes, {
      req, res, url: new URL(req.url!, "http://x"), path: PLAN_PATH, method: req.method!, json,
      sender: { id: "dog" } as BotRecord, threadId: "thread-1", capability: {}, readBody: () => readBody(req),
    });
    if (!handled) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${PLAN_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { post, plans, changed };
}

describe("set_plan route", () => {
  it("records the whole list for the chat and says so in one line", async () => {
    const { post, plans, changed } = await serve();
    const reply = await post({ items: [{ text: "Fix the login", status: "in_progress" }] });
    expect(reply).toEqual({ status: 200, body: { recorded: true, plan: { items: [{ text: "Fix the login", status: "in_progress" }], updatedAt: 7 }, text: "Plan recorded: 0 of 1 done, now “Fix the login”. The person sees it in the app." } });
    expect(plans.get("thread-1")?.items).toHaveLength(1);
    expect(changed).toEqual(["thread-1"]);
  });

  it("keeps a native helper's call out of its dog's plan", async () => {
    const { post, plans, changed } = await serve({ "toolu_helper": "helper" });
    await post({ items: [{ text: "Dog's item", status: "pending" }] });
    const reply = await post({ items: [{ text: "Helper's item", status: "pending" }], toolUseId: "toolu_helper" });
    expect(reply.body).toEqual({ recorded: false, text: HELPER_PLAN_TEXT });
    expect(plans.get("thread-1")?.items).toEqual([{ text: "Dog's item", status: "pending" }]);
    expect(changed).toEqual(["thread-1"]);
  });

  it("leaves out that the person sees it for a room's plan, which no app shows yet", async () => {
    const { post } = await serve({}, false);
    expect((await post({ items: [{ text: "Room work", status: "pending" }] })).body.text).toBe("Plan recorded: 0 of 1 done, 1 not started.");
  });

  it("refuses a list it cannot keep", async () => {
    const { post, plans } = await serve();
    expect((await post({ items: [{ text: "x", status: "started" }] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(plans.get("thread-1")).toBeUndefined();
  });
});
