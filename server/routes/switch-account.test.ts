import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { BatteryAccount, Rest } from "../laterdog/account-battery.ts";
import { matchAccount, SWITCH_ACCOUNT_PATH } from "../laterdog/account-switch.ts";
import type { BotRecord } from "../store.ts";
import { dispatchInternalRoutes } from "./internal.ts";
import { createSwitchAccountRoute } from "./switch-account.ts";

const NOW = Date.parse("2026-11-06T18:00:00Z");
const account = (instanceId: string, email: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: "Claude", email, enabled: true, eligible: true, signedIn: true,
  models: ["claude-opus-5-5"], ...extra,
});
const ACCOUNTS = [
  account("claude", "adam@txtclaw.com"),
  account("claude-jacob", "jacob@txtclaw.com"),
  account("claude-daniel", "daniel@txtclaw.com"),
  account("claude-anthony", "anthony@txtclaw.com", { enabled: false }),
];
const SENDER = { id: "olivia", name: "olivia site" } as BotRecord;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve(options: { resting?: Record<string, Rest>; group?: boolean } = {}) {
  let selection: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5" };
  const saved: ModelSelection[] = [];
  const released: string[] = [];
  const route = createSwitchAccountRoute({
    active: () => true,
    accounts: () => ACCOUNTS,
    chat: (sender) => (options.group ? null : { ...sender, modelSelection: selection } as BotRecord),
    check: (_chat, next) => ({ ok: true, selection: next }),
    save: (_sender, _threadId, next) => { saved.push(next); selection = next; },
    release: (threadId) => { released.push(threadId); },
    route: (next) => (options.resting?.[next.instanceId] ? { ...next, instanceId: "claude-jacob" } : next),
    rest: (picked) => options.resting?.[picked.instanceId],
    preferred: () => undefined,
    timeZone: () => "America/Los_Angeles",
    now: () => NOW,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchInternalRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", json, sender: SENDER, threadId: "olivia-chat", capability: {}, readBody: () => readBody(req) })) return;
    json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ask = async (name: string) => {
    const answer = await fetch(`${base}${SWITCH_ACCOUNT_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: name }) });
    return { status: answer.status, body: await answer.json() as { text?: string; error?: string; account?: string; runsOn?: string } };
  };
  return { ask, saved, released };
}

describe("switch to an account by name from the chat", () => {
  it("knows the accounts by the names the person uses", () => {
    expect((matchAccount("daniel", ACCOUNTS) as BatteryAccount).instanceId).toBe("claude-daniel");
    expect((matchAccount("switch to Daniel", ACCOUNTS) as BatteryAccount).instanceId).toBe("claude-daniel");
    expect((matchAccount("continue with jacob", ACCOUNTS) as BatteryAccount).instanceId).toBe("claude-jacob");
    expect((matchAccount("adam@txtclaw.com", ACCOUNTS) as BatteryAccount).instanceId).toBe("claude");
    expect((matchAccount("a", ACCOUNTS) as BatteryAccount[]).map((each) => each.instanceId)).toEqual(["claude", "claude-anthony"]);
    expect(matchAccount("bob", ACCOUNTS)).toEqual([]);
  });

  it("moves this chat onto the account, drops the old placement, and says in one line where it is", async () => {
    const { ask, saved, released } = await serve();
    expect(await ask("daniel")).toEqual({ status: 200, body: { account: "claude-daniel", runsOn: "claude-daniel", text: "This chat is on daniel now." } });
    expect(saved).toEqual([{ instanceId: "claude-daniel", model: "claude-opus-5-5" }]);
    expect(released).toEqual(["olivia-chat"]);
  });

  it("says why when the picked account is used up, and which account the chat runs on until then", async () => {
    const { ask } = await serve({ resting: { "claude-daniel": { until: "2026-11-06T22:00:00Z", since: "2026-11-06T17:00:00Z", kind: "session" } } });
    const answer = await ask("daniel");
    expect(answer.body.runsOn).toBe("claude-jacob");
    expect(answer.body.text?.replace(/\s/g, " ")).toBe("This chat is set to daniel, but daniel is used up until 2:00 PM, so it runs on jacob until then.");
  });

  it("refuses an account that is off or unknown, naming the ones there are, and leaves group chats to the person", async () => {
    const { ask, saved } = await serve();
    expect(await ask("anthony")).toEqual({ status: 409, body: { error: "anthony is switched off, so this chat stays where it is. The accounts here are adam, jacob, daniel, anthony." } });
    expect(await ask("bob")).toEqual({ status: 404, body: { error: 'No account called "bob". The accounts here are adam, jacob, daniel, anthony.' } });
    expect(saved).toEqual([]);
    expect((await (await serve({ group: true })).ask("daniel")).status).toBe(409);
  });
});
