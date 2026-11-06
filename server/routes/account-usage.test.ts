import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { ACCOUNT_USAGE_PATH } from "../laterdog/account-usage.ts";
import type { BotRecord } from "../store.ts";
import { createAccountUsageRoute } from "./account-usage.ts";
import { dispatchInternalRoutes } from "./internal.ts";

const SENDER = { id: "dog-reflow", name: "reflow ai" } as BotRecord;
const NOW = Date.parse("2026-11-06T07:00:00Z");
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve(active = true) {
  const refreshed: boolean[] = [];
  const route = createAccountUsageRoute({
    active: () => active,
    refresh: async (fresh) => { refreshed.push(fresh); },
    accounts: () => [{
      account: { instanceId: "claude-daniel", driverKind: "claudeAgent", displayName: "Claude", email: "daniel@txtclaw.com", enabled: true, eligible: true, models: [] },
      row: { id: "claude-daniel", name: "Claude", driver: "claude", plan: null, ok: true, error: null, extra: [], models: [],
        fiveHour: { available: true, usedPercent: 30, remainingPercent: 70, resetsAt: "2026-11-06T09:00:00Z" },
        weekly: { available: true, usedPercent: 21, remainingPercent: 79, resetsAt: "2026-11-08T09:00:00Z" } },
      rest: undefined,
      env: { name: "CLAUDE_CONFIG_DIR", value: "/data/.laterdog/providers/claude-daniel" },
    }],
    current: (sender, threadId) => (sender.id === "dog-reflow" && threadId === "main" ? "claude-daniel" : undefined),
    timeZone: () => "UTC",
    now: () => NOW,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchInternalRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", json, sender: SENDER, threadId: "main", capability: {}, readBody: () => readBody(req) })) return;
    json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, refreshed };
}

describe("the account usage a dog can ask for", () => {
  it("answers with each account, the one this chat is on and the one with the most room, refreshing only when asked", async () => {
    const { base, refreshed } = await serve();
    const body = await (await fetch(`${base}${ACCOUNT_USAGE_PATH}`)).json() as { text: string };
    expect(body).toMatchObject({ roomiest: "claude-daniel", current: "claude-daniel", accounts: [{ id: "claude-daniel", leftPercent: 70, current: true }] });
    expect(body.text).toContain("[id: claude-daniel, Claude, this chat, most room]: 70% left.");
    await fetch(`${base}${ACCOUNT_USAGE_PATH}?refresh=1`);
    expect(refreshed).toEqual([false, true]);
  });

  it("refuses an expired turn and leaves other paths to the next route", async () => {
    const { base } = await serve(false);
    expect((await fetch(`${base}${ACCOUNT_USAGE_PATH}`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/internal/other`)).json()).toEqual({ from: "inline routes" });
  });
});
