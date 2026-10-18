import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";

const discoverySteps = () => [
  { tool: "list_bots", arguments: {} },
  { tool: "list_room_targets", arguments: {} },
];

const toolResult = (turn: any, name: string) => {
  const response = turn.evidence.find((entry: any) => entry.step?.tool === name)?.response;
  expect(response?.error).toBeUndefined();
  expect(response?.result?.isError).toBeFalsy();
  const text = response.result.content[0].text;
  return name === "list_bots" ? text : JSON.parse(text);
};

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  const planPath = join(session.info.dataDir, "room-plan.json");
  const plan: Record<string, any> = {};
  const readArray = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const nodes = () => readArray(join(session.info.dataDir, "room-handoffs.json"));
  const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
  const receipts: unknown[] = [];
  const start = async (bot: any) => {
    writeFileSync(planPath, JSON.stringify(plan));
    const sent = await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Run the cross-pack roster verification");
    const waited = await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30");
    receipts.push({ botId: bot.id, sent, waited, messages: await messages(bot.activeTaskId) });
    expect(waited.status).toBe("settled");
  };
  try {
    const sender = (await cli("new-bot", "--name", "Coordinator", "--section", "Planning")).bot;
    const target = (await cli("new-bot", "--name", "Rio", "--section", "Voice")).bot;
    expect(sender.chiefOfStaff).not.toBe(true);
    expect(target.chiefOfStaff).not.toBe(true);
    await test({ session, cli, api, tool, sender, target, plan, start, evidence, nodes, messages });
  } finally {
    try {
      writeFileSync(`${session.info.logPath}.account-wide-roster.json`, JSON.stringify({ fixture: session.info, receipts, turns: evidence(), handoffs: nodes() }, null, 2));
    } finally { await session.close(); }
  }
}

it("advertises ordinary bots in different packs bidirectionally through both MCP discovery tools", () => fixture(async f => {
  for (const bot of [f.sender, f.target]) {
    f.plan[bot.id] = { steps: discoverySteps(), reply: "Roster checked" };
    await f.start(bot);
  }
  for (const [from, to] of [[f.sender, f.target], [f.target, f.sender]]) {
    const turn = f.evidence().find((entry: any) => entry.botId === from.id);
    expect(toolResult(turn, "list_bots")).toContain(`[id: ${to.id},`);
    expect(toolResult(turn, "list_bots")).toContain(`team: ${to.section}`);
    expect(toolResult(turn, "list_room_targets").bots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: to.id, name: to.name, section: to.section }),
    ]));
    expect(turn.system).toContain(`[id: ${to.id}]`);
  }
}), 60_000);

it("executes a cross-pack coordinate_bots request and returns the exact peer reply", () => fixture(async f => {
  f.plan[f.sender.id] = {
    steps: [...discoverySteps(), { tool: "coordinate_bots", arguments: { bot_ids: [f.target.id], message: "Verify the voice selection fixture and report its exact result" } }],
    reply: "Voice verification assigned", resumeReply: "Reviewed Rio's verified voice result",
  };
  f.plan[f.target.id] = { steps: discoverySteps(), reply: "Rio verified the voice selection fixture", expectContextIncludes: [f.sender.id] };
  await f.start(f.sender);
  const turns = f.evidence();
  expect(turns.map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, f.sender.id]);
  expect(toolResult(turns[0], "coordinate_bots")).toMatchObject({ receipts: [expect.objectContaining({ botId: f.target.id })] });
  const child = f.nodes().find((node: any) => node.botId === f.target.id);
  expect(child).toMatchObject({ status: "completed", result: "Rio verified the voice selection fixture" });
  expect(turns[2].resumed).toBe(true);
  expect(JSON.stringify(turns[2].prompt)).toContain("Rio verified the voice selection fixture");
  expect((await f.messages(f.sender.activeTaskId)).some((message: any) => message.text === "Reviewed Rio's verified voice result")).toBe(true);
  expect((await f.api("/api/bots?messages=0")).groups).toEqual([]);
}), 60_000);

it("preserves explicit peer exclusions, hidden bots and different private-user audiences across packs", () => fixture(async f => {
  const hidden = (await f.cli("new-bot", "--name", "Archived dog", "--section", "Archive")).bot;
  const denied = (await f.cli("new-bot", "--name", "Excluded dog", "--section", "Research")).bot;
  const privateA = (await f.cli("new-bot", "--name", "Ada private", "--section", "Private A")).bot;
  const privateB = (await f.cli("new-bot", "--name", "Bob private", "--section", "Private B")).bot;
  await f.api(`/api/bots/${hidden.id}`, { hidden: true }, "PATCH");
  await f.api(`/api/bots/${privateA.id}`, { visibility: { people: ["ada@example.test"] } }, "PATCH");
  await f.api(`/api/bots/${privateB.id}`, { visibility: { people: ["bob@example.test"] } }, "PATCH");
  await f.api(`/api/bots/${f.sender.id}`, { peers: [f.target.id, hidden.id, privateA.id, privateB.id] }, "PATCH");
  const refusal = (botId: string) => ({ tool: "coordinate_bots", expectError: true, arguments: { bot_ids: [botId], message: "Confirm this forbidden request is refused" } });
  f.plan[f.sender.id] = { steps: [...discoverySteps(), ...[denied, hidden, privateA, privateB].map(bot => refusal(bot.id))], reply: "Restrictions verified" };
  f.plan[privateA.id] = { steps: [...discoverySteps(), refusal(privateB.id)], reply: "Private audience verified" };
  await f.start(f.sender);
  await f.start(privateA);
  for (const bot of [f.sender, privateA]) {
    const turn = f.evidence().find((entry: any) => entry.botId === bot.id);
    for (const name of ["list_bots", "list_room_targets"]) {
      const result = toolResult(turn, name);
      const ids = name === "list_bots"
        ? Array.from((result as string).matchAll(/\[id: ([^,]+),/g), match => match[1])
        : result.bots.map((peer: any) => peer.id);
      if (bot.id === f.sender.id) expect(ids).toEqual([f.target.id]);
      else expect(ids).toEqual([]);
    }
    const attempts = turn.evidence.filter((entry: any) => entry.step?.tool === "coordinate_bots");
    expect(attempts).toHaveLength(bot.id === f.sender.id ? 4 : 1);
    expect(attempts.every((entry: any) => entry.response.result.isError)).toBe(true);
  }
  expect(f.nodes()).toEqual([]);
  expect(f.evidence().map((entry: any) => entry.botId)).toEqual([f.sender.id, privateA.id]);
}), 60_000);

it("coordinates into a same-audience room in another pack through the actual MCP proxy", () => fixture(async f => {
  const room = (await f.tool("create_channel", { name: "Voice review", member_ids: [f.target.id] })).channel;
  f.plan[f.sender.id] = {
    steps: [...discoverySteps(), { tool: "coordinate_bots", arguments: { group_id: room.id, bot_ids: [f.target.id], message: "Verify voice playback in this room" } }],
    reply: "Room verification assigned", resumeReply: "Room result verified",
  };
  f.plan[f.target.id] = { reply: "Voice playback verified in the room" };
  await f.start(f.sender);
  const firstTurn = f.evidence().find((entry: any) => entry.botId === f.sender.id);
  expect(toolResult(firstTurn, "list_room_targets").rooms).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: room.id, members: [expect.objectContaining({ id: f.target.id })] }),
  ]));
  expect(f.nodes().find((node: any) => node.botId === f.target.id)).toMatchObject({ groupId: room.id, status: "completed", result: "Voice playback verified in the room" });
  expect((await f.messages(room.activeTaskId)).some((message: any) => message.text === "Voice playback verified in the room")).toBe(true);
}), 60_000);

it("withholds a room whose historical audience is narrower than its current cross-pack members", () => fixture(async f => {
  const former = (await f.cli("new-bot", "--name", "Former private reader", "--section", "Private")).bot;
  const room = (await f.tool("create_channel", { name: "Private history", member_ids: [f.target.id, former.id] })).channel;
  await f.api(`/api/bots/${former.id}`, { visibility: { people: ["ada@example.test"] } }, "PATCH");
  await f.api(`/api/groups/${room.id}`, { memberIds: [f.target.id] }, "PATCH");
  const persisted = (await f.api("/api/bots?messages=0")).groups.find((group: any) => group.id === room.id);
  expect(persisted.audienceFloor).toEqual({ people: ["ada@example.test"] });
  f.plan[f.sender.id] = {
    steps: [...discoverySteps(), { tool: "coordinate_bots", expectError: true, arguments: { group_id: room.id, bot_ids: [f.target.id], message: "Do not expose the previous private room history" } }],
    reply: "Historical audience boundary verified",
  };
  await f.start(f.sender);
  const turn = f.evidence().find((entry: any) => entry.botId === f.sender.id);
  expect(toolResult(turn, "list_room_targets").rooms.map((entry: any) => entry.id)).not.toContain(room.id);
  expect(toolResult(turn, "list_bots")).toContain(`[id: ${f.target.id},`);
  const refusal = turn.evidence.find((entry: any) => entry.step?.tool === "coordinate_bots");
  expect(refusal.response.result.isError).toBe(true);
  expect(f.nodes()).toEqual([]);
}), 60_000);
