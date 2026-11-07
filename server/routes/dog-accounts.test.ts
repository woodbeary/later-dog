import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { BatteryAccount } from "../laterdog/account-battery.ts";
import { accountTurnPrompt, type AccountUsageInput } from "../laterdog/account-usage.ts";
import type { BotRecord } from "../store.ts";
import { createDogAccountsRoute, DOG_ACCOUNTS_PATH, matchDogs } from "./dog-accounts.ts";
import { dispatchInternalRoutes } from "./internal.ts";

const NOW = Date.parse("2026-11-07T18:00:00Z");
const account = (instanceId: string, email: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: "Claude", email, enabled: true, eligible: true, signedIn: true,
  models: ["claude-opus-5-5"], ...extra,
});
const ACCOUNTS = [account("claude", "adam@txtclaw.com"), account("claude-daniel", "daniel@txtclaw.com"), account("claude-anthony", "anthony@txtclaw.com")];
const window = (usedPercent: number) => ({ available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: "2026-11-07T20:00:00Z" });
const row = (id: string, session: number, weekly: number) => ({ id, name: "Claude", plan: "max", ok: true, fiveHour: window(session), weekly: window(weekly) }) as never;
const USAGE: AccountUsageInput[] = [
  { account: ACCOUNTS[0]!, row: row("claude", 99, 80), rest: undefined },
  { account: ACCOUNTS[1]!, row: row("claude-daniel", 30, 40), rest: undefined },
  { account: ACCOUNTS[2]!, row: row("claude-anthony", 20, 10), rest: undefined },
];
const dog = (id: string, name: string, instanceId: string): BotRecord => ({ id, name, threadId: `${id}-chat`, modelSelection: { instanceId, model: "claude-opus-5-5" } }) as BotRecord;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve(sender: BotRecord, owner = true) {
  const dogs = [dog("clover", "Clover", "claude-anthony"), dog("task", "task", "claude"), dog("nextdoor", "nextdoor", "claude"), dog("olivia", "olivia site", "claude-daniel")];
  const assigned: string[] = [];
  const route = createDogAccountsRoute({
    active: () => true,
    ownerActing: () => owner,
    mainBotId: () => "clover",
    dogs: () => dogs,
    accounts: () => ACCOUNTS,
    usage: () => USAGE,
    refresh: async () => undefined,
    runsOn: (bot) => (bot.id === "nextdoor" ? "claude-anthony" : undefined),
    busy: (bot) => bot.id === "task",
    assign: (bot, to) => {
      assigned.push(`${bot.id}->${to.instanceId}`);
      const index = dogs.indexOf(bot);
      dogs[index] = { ...bot, modelSelection: { ...bot.modelSelection, instanceId: to.instanceId }, accountPinned: true };
      return { ok: true };
    },
    timeZone: () => "America/Los_Angeles",
    now: () => NOW,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchInternalRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", json, sender, threadId: `${sender.id}-chat`, capability: {}, readBody: () => readBody(req) })) return;
    json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${DOG_ACCOUNTS_PATH}`;
  const call = async (body?: unknown) => {
    const answer = await fetch(base, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() as { text?: string; error?: string; moved?: string[] } };
  };
  return { call, assigned, dogs };
}

describe("the main dog sees and assigns every dog's account", () => {
  it("shows every dog's account, where it runs now, and each account's session and weekly usage", async () => {
    const { call } = await serve(dog("clover", "Clover", "claude-anthony"));
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.text).toContain("- daniel [id: claude-daniel, Claude]: ready; 5-hour 30% used");
    expect(body.text).toContain("7-day 40% used");
    expect(body.text).toContain("- task [id: task, working]: adam");
    expect(body.text).toContain("- nextdoor [id: nextdoor]: adam, running on anthony for now");
    expect(body.text).toContain("- Clover [id: clover, main dog]: anthony");
  });

  it("puts task and nextdoor on daniel, pinned, and shows them there", async () => {
    const { call, assigned } = await serve(dog("clover", "Clover", "claude-anthony"));
    const { status, body } = await call({ dogs: ["task", "nextdoor"], account: "daniel" });
    expect(status).toBe(200);
    expect(assigned).toEqual(["task->claude-daniel", "nextdoor->claude-daniel"]);
    expect(body.moved).toEqual(["task", "nextdoor"]);
    expect(body.text).toMatch(/^Put task, nextdoor on daniel, pinned\./);
    expect(body.text).toContain("- task [id: task, pinned, working]: daniel");
  });

  it("names a dog or account it can't find instead of guessing", async () => {
    const { call, assigned } = await serve(dog("clover", "Clover", "claude-anthony"));
    expect((await call({ dogs: ["nobody"], account: "daniel" })).body.text).toContain('No dog called "nobody".');
    expect((await call({ dogs: ["task"], account: "bob" })).status).toBe(404);
    expect(assigned).toEqual([]);
    expect(matchDogs(["olivia"], [dog("olivia", "olivia site", "claude")]).found.map((each) => each.id)).toEqual(["olivia"]);
  });

  it("lets any of the owner's dogs put another dog on an account, so a broken dog is fixed instead of duplicated", async () => {
    const { call, assigned } = await serve(dog("task", "task", "claude"));
    const { status, body } = await call({ dogs: ["olivia site"], account: "daniel" });
    expect(status).toBe(200);
    expect(assigned).toEqual(["olivia->claude-daniel"]);
    expect(body.text).toMatch(/^Put olivia site on daniel, pinned\./);
  });

  it("refuses a dog that isn't working for the owner in the owner's home", async () => {
    const { call, assigned } = await serve(dog("task", "task", "claude"), false);
    expect((await call()).status).toBe(403);
    expect((await call({ dogs: ["nextdoor"], account: "daniel" })).status).toBe(403);
    expect(assigned).toEqual([]);
  });
});

describe("every dog knows its account", () => {
  it("states the account the turn runs on and its session and weekly room", () => {
    const text = accountTurnPrompt(USAGE[1], NOW, "America/Los_Angeles");
    expect(text).toContain("This turn runs on the Claude plan account daniel (daniel@txtclaw.com): session (5-hour) 70% left, weekly 60% left.");
    expect(accountTurnPrompt(undefined, NOW)).toBe("");
  });
});
