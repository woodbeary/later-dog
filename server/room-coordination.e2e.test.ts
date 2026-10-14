import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { PEER_ACCESS_HELP } from "./peer-roster.ts";

async function withRooms(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { LATERDOG_URL: session.info.url };
  const cli = (...args: string[]) => runControlLaterDog(args, { env }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  try {
    const sender = (await cli("new-bot", "--name", "Director", "--section", "A")).bot;
    const target = (await cli("new-bot", "--name", "Engineer", "--section", "A")).bot;
    const source = (await tool("create_channel", { name: "Planning", member_ids: [sender.id], bulletin: "SOURCE_ONLY" })).channel;
    const destination = (await tool("create_channel", { name: "Engineering", member_ids: [target.id], bulletin: "DESTINATION_ONLY" })).channel;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [sender.id]: { steps: [{ arguments: { group_id: destination.id, bot_ids: [target.id], message: "Please build CSV" } }], reply: "Assigned", resumeReply: "Reviewed downstream outcome" },
      [target.id]: { reply: "Built CSV" },
    };
    const savePlan = () => writeFileSync(planPath, JSON.stringify(plan));
    const nodes = () => {
      const file = join(session.info.dataDir, "room-handoffs.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    };
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const start = async () => { savePlan(); return cli("send-channel", "--channel", source.id, "--text", "@Director Start the assignment"); };
    const wait = async () => cli("wait", "--channel", source.id, "--timeout", "30");
    const provider = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    await test({ session, api, cli, tool, sender, target, source, destination, plan, savePlan, nodes, messages, start, wait, provider });
  } finally { await session.close(); }
}

async function addSupervisingChief(f: any, section = "") {
  const chief = (await f.cli("new-bot", "--name", "Supervisor")).bot;
  await f.api(`/api/bots/${chief.id}`, { section, chiefOfStaff: true, managedSections: ["A"], acknowledgePeerScope: true }, "PATCH");
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, chief.id] });
  f.plan[chief.id] = { reply: "Supervisor checked the work" };
  return chief;
}

it.each(["", "Leadership"])("lists and coordinates with a supervising Chief and same-section peer in the same room (Chief section %j)", section => withRooms(async f => {
  const chief = await addSupervisingChief(f, section);
  f.plan[f.sender.id].steps = [{ arguments: { bot_ids: [chief.id, f.target.id], message: "Review the work here" } }];
  f.plan[f.target.id] = { reply: "Built CSV", expectContextIncludes: ["[LIVE TEAMMATES]", `[id: ${f.sender.id}]`] };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const discovery = JSON.parse(f.provider().find((turn: any) => turn.botId === f.sender.id).evidence[1].result.content[0].text);
  expect(discovery.rooms.find((room: any) => room.id === f.source.id).members.map((bot: any) => bot.id)).toEqual(expect.arrayContaining([chief.id, f.target.id]));
  const children = f.nodes().filter((node: any) => node.parentId);
  expect(children.map((node: any) => node.botId).sort()).toEqual([chief.id, f.target.id].sort());
  expect(children.every((node: any) => node.status === "completed" && node.groupId === f.source.id && node.threadId === f.source.activeTaskId)).toBe(true);
}), 45_000);

it.each(["unmanaged", "other-pack-reader"])("coordinates in the same room with %s", reason => withRooms(async f => {
  const chief = await addSupervisingChief(f);
  if (reason === "unmanaged") await f.api(`/api/bots/${chief.id}`, { managedSections: [] }, "PATCH");
  if (reason === "other-pack-reader") {
    const outsider = (await f.cli("new-bot", "--name", "Outsider", "--section", "Finance")).bot;
    await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, chief.id, outsider.id] });
  }
  f.plan[f.sender.id].steps = [{ arguments: { bot_ids: [chief.id], message: "Review the work across packs" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((node: any) => node.parentId)).toMatchObject({ botId: chief.id, groupId: f.source.id, status: "completed" });
  const discovery = JSON.parse(f.provider().find((entry: any) => entry.botId === f.sender.id).evidence[1].result.content[0].text);
  expect(discovery.rooms.find((room: any) => room.id === f.source.id).members.map((bot: any) => bot.id)).toContain(chief.id);
  expect(f.provider().map((entry: any) => entry.botId)).toEqual([f.sender.id, chief.id, f.sender.id]);
}), 45_000);

it("refuses same-room supervisor coordination with a disallowed peer", () => withRooms(async f => {
  const chief = await addSupervisingChief(f);
  await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  f.plan[f.sender.id].steps = [{ expectError: true, arguments: { bot_ids: [chief.id], message: "Do not bypass the peer restriction" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  const turn = f.provider().find((entry: any) => entry.botId === f.sender.id);
  expect(turn.evidence.find((entry: any) => entry.step).response.result.isError).toBe(true);
  expect(JSON.parse(turn.evidence[1].result.content[0].text).rooms).toEqual([]);
  expect(f.provider().some((entry: any) => entry.botId === chief.id)).toBe(false);
}), 45_000);

it("coordinates with a Chief in a different room across packs", () => withRooms(async f => {
  const chief = await addSupervisingChief(f, "Leadership");
  await f.tool("update_channel", { channel_id: f.destination.id, member_ids: [chief.id] });
  f.plan[f.sender.id].steps = [{ arguments: { group_id: f.destination.id, bot_ids: [chief.id], message: "Review this work in the destination room" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((node: any) => node.parentId)).toMatchObject({ botId: chief.id, groupId: f.destination.id, status: "completed" });
  expect((await f.messages(f.destination.activeTaskId)).some((message: any) => message.text === "Supervisor checked the work")).toBe(true);
  const discovery = JSON.parse(f.provider().find((turn: any) => turn.botId === f.sender.id).evidence[1].result.content[0].text);
  expect(discovery.rooms.some((room: any) => room.id === f.destination.id)).toBe(true);
  expect(JSON.stringify(f.provider().find((turn: any) => turn.botId === chief.id).prompt)).not.toContain("SOURCE_ONLY");
}), 45_000);

it("refuses queued same-room supervisor work when the owner revokes peer access", () => withRooms(async f => {
  const chief = await addSupervisingChief(f);
  const gateFile = join(f.session.info.dataDir, "supervisor-result.gate");
  f.plan[chief.id] = { reply: "PRIVATE_SUPERVISOR_RESULT" };
  f.plan[f.sender.id].gateFile = gateFile;
  f.plan[f.sender.id].steps = [{ arguments: { bot_ids: [chief.id], message: "Review this work" } }];
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15000 }).toBe("queued");
  await request(`/api/bots/${f.sender.id}`, { method: "PATCH", headers: { Origin: f.session.info.url }, body: JSON.stringify({ peers: [] }) }, f.session.info.url);
  writeFileSync(gateFile, "release");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((node: any) => node.parentId).status).toBe("failed");
  expect(f.provider().some((turn: any) => turn.botId === chief.id)).toBe(false);
  expect(JSON.stringify(await f.messages(f.source.activeTaskId))).not.toContain("PRIVATE_SUPERVISOR_RESULT");
  expect((await f.messages(f.source.activeTaskId)).some((message: any) => message.tool?.name.includes("reply was held back"))).toBe(true);
}), 45_000);

it("refuses a disallowed peer without starting the recipient", () => withRooms(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  f.plan[f.sender.id].steps[0].expectError = true;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
}), 45_000);

it("runs room-destined work in the room's own conversation, opening no thread on the recipient", () => withRooms(async f => {
  const tasksOf = async (botId: string) => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === botId).tasks ?? [];
  const before = await tasksOf(f.target.id);
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const node = f.nodes().find((n: any) => n.botId === f.target.id);
  expect(node.groupId).toBe(f.destination.id);
  expect(node.threadId).toBe(f.destination.activeTaskId);
  const after = await tasksOf(f.target.id);
  expect(after.map((task: any) => task.threadId)).toEqual(before.map((task: any) => task.threadId));
  expect(after.some((task: any) => task.openedBy)).toBe(false);
  expect((await f.messages(f.destination.activeTaskId)).some((m: any) => m.text?.includes("Please build CSV"))).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
  expect(JSON.stringify(f.provider().find((turn: any) => turn.botId === f.target.id).prompt).match(/Please build CSV/g)).toHaveLength(1);
}), 45_000);

it("lets an ordinary bot coordinate another pack, which can consult its own specialist", () => withRooms(async f => {
  await f.api(`/api/bots/${f.target.id}`, { section: "Engineering" }, "PATCH");
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "Engineering")).bot;
  const reviewRoom = (await f.tool("create_channel", { name: "Quality", member_ids: [reviewer.id] })).channel;
  f.plan[f.target.id] = {
    steps: [{ arguments: { group_id: reviewRoom.id, bot_ids: [reviewer.id], message: "Check the CSV output" } }],
    reply: "Sent for verification", resumeReply: "CSV implemented and checked",
  };
  f.plan[reviewer.id] = { reply: "CSV checks passed\nrow count matches\nno nulls" };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, reviewer.id, f.target.id, f.sender.id]);
  expect(f.nodes().every((n: any) => n.status === "completed")).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
  const resumedPrompt = f.provider().filter((turn: any) => turn.botId === f.target.id).at(-1).prompt;
  expect(JSON.stringify(resumedPrompt).match(/CSV checks passed/g)).toHaveLength(1);
  const bots = (await f.api("/api/bots")).bots;
  expect(bots.find((b: any) => b.id === f.sender.id).chiefOfStaff).not.toBe(true);
  expect(bots.find((b: any) => b.id === f.sender.id).managedSections).toBeUndefined();
  expect(bots.find((b: any) => b.id === f.target.id).managedSections).toBeUndefined();
  expect(bots.find((b: any) => b.id === reviewer.id).managedSections).toBeUndefined();
}), 45_000);

it("does not let a Chief's grant expose a different-audience room transcript to its specialist", () => withRooms(async f => {
  await f.api(`/api/bots/${f.target.id}`, { section: "Engineering" }, "PATCH");
  const finance = (await f.cli("new-bot", "--name", "Finance", "--section", "Finance")).bot;
  await f.api(`/api/bots/${f.sender.id}`, { chiefOfStaff: true, managedSections: ["Engineering", "Finance"], acknowledgePeerScope: true }, "PATCH");
  await f.tool("update_channel", { channel_id: f.destination.id, member_ids: [f.target.id, finance.id] });
  await f.api(`/api/bots/${finance.id}`, { visibility: "admins" }, "PATCH");
  f.plan[f.sender.id].steps[0].expectError = true;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id]);
  expect(JSON.stringify(f.provider())).not.toContain("DESTINATION_ONLY");
}), 45_000);

it("withholds a cross-pack result if the owner revokes peer access while it runs", () => withRooms(async f => {
  await f.api(`/api/bots/${f.target.id}`, { section: "Engineering" }, "PATCH");
  await f.api(`/api/bots/${f.sender.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
  f.plan[f.target.id] = { delayMs: 3000, reply: "PRIVATE_RESULT_AFTER_REVOCATION" };
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((n: any) => n.parentId).status).toBe("failed");
  const messages = await f.messages(f.source.activeTaskId);
  expect(JSON.stringify(messages)).not.toContain("PRIVATE_RESULT_AFTER_REVOCATION");
  expect(messages.some((m: any) => m.tool?.name.includes("reply was held back"))).toBe(true);
}), 45_000);

it.each(["rename", "delete"])("returns an in-flight result after team %s and recreation without restoring management grants", mode => withRooms(async f => {
  await f.api(`/api/bots/${f.target.id}`, { section: "Engineering" }, "PATCH");
  await f.api(`/api/bots/${f.sender.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
  f.plan[f.target.id] = { delayMs: 5000, reply: "RESULT_AFTER_TEAM_RECREATION" };
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const move = (section: string) => request(`/api/bots/${f.target.id}`, { method: "PATCH", headers: { Origin: f.session.info.url },
    body: JSON.stringify({ section }) }, f.session.info.url);
  await move("Parking");
  await f.api("/api/sidebar-sections?section=Engineering", mode === "rename" ? { name: "Renamed" } : {}, mode === "rename" ? "PATCH" : "DELETE");
  await f.api("/api/sidebar-sections", { name: "Engineering" });
  await move("Engineering");
  const chief = (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.sender.id);
  expect(chief.managedSections).toEqual([]);
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((n: any) => n.parentId)).toMatchObject({ status: "completed", result: "RESULT_AFTER_TEAM_RECREATION" });
  const messages = await f.messages(f.source.activeTaskId);
  expect(messages.some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
  expect(messages.some((m: any) => m.tool?.name.includes("reply was held back"))).toBe(false);
  expect(JSON.stringify(f.provider().filter((turn: any) => turn.botId === f.sender.id).at(-1).prompt)).toContain("RESULT_AFTER_TEAM_RECREATION");
}), 45_000);

it.each(["recipient", "source-reader", "destination-reader"])("refuses work involving a different-audience %s without leaking room history", role => withRooms(async f => {
  await f.api(`/api/bots/${f.target.id}`, { section: "Other pack" }, "PATCH");
  if (role === "recipient") await f.api(`/api/bots/${f.target.id}`, { visibility: "admins" }, "PATCH");
  else {
    const outsider = (await f.cli("new-bot", "--name", "Outsider", "--section", "Other pack")).bot;
    const room = role === "source-reader" ? f.source : f.destination;
    await f.tool("update_channel", { channel_id: room.id, member_ids: [...room.memberIds, outsider.id] });
    if (role === "source-reader") {
      await f.api(`/api/bots/${f.sender.id}`, { visibility: "admins" }, "PATCH");
      await f.api(`/api/bots/${f.target.id}`, { visibility: "admins" }, "PATCH");
    } else await f.api(`/api/bots/${outsider.id}`, { visibility: "admins" }, "PATCH");
  }
  f.plan[f.sender.id].steps[0].expectError = true;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Assigned")).toBe(true);
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id]);
  expect(JSON.stringify(f.provider())).not.toContain("DESTINATION_ONLY");
  const discovery = f.provider().find((turn: any) => turn.botId === f.sender.id).evidence[1];
  if (role === "source-reader") expect(discovery.result.isError).toBe(true);
  else expect(JSON.parse(discovery.result.content[0].text).rooms).toEqual([]);
}), 45_000);

it.each([false, true])("coordinates across packs in the same room only with matching audiences (restricted sender %s)", restricted => withRooms(async f => {
  await f.api(`/api/bots/${f.target.id}`, { section: "Other pack" }, "PATCH");
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id] });
  if (restricted) await f.api(`/api/bots/${f.sender.id}`, { visibility: "admins" }, "PATCH");
  f.plan[f.sender.id].steps = [{ expectError: restricted, arguments: { bot_ids: [f.target.id], message: "Review CSV" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  if (restricted) {
    expect(f.nodes()).toEqual([]);
    expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id]);
  } else {
    expect(f.nodes().find((node: any) => node.parentId)).toMatchObject({ botId: f.target.id, groupId: f.source.id, status: "completed" });
    expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, f.sender.id]);
  }
}), 45_000);

it("dispatches queued work after its recipient moves to another pack", () => withRooms(async f => {
  const gateFile = join(f.session.info.dataDir, "recipient-section-change.gate");
  f.plan[f.target.id].gateFile = gateFile; f.savePlan();
  await f.cli("send", "--bot", f.target.id, "--text", "Independent task");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  await request(`/api/bots/${f.target.id}`, { method: "PATCH", headers: { Origin: f.session.info.url },
    body: JSON.stringify({ section: "Other pack" }) }, f.session.info.url);
  writeFileSync(gateFile, "release");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((n: any) => n.parentId).status).toBe("completed");
  expect((await f.messages(f.destination.activeTaskId)).some((m: any) => m.text === "Built CSV")).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.tool?.name.includes("reply was held back"))).toBe(false);
  await f.cli("wait", "--bot", f.target.id, "--timeout", "15");
}), 45_000);

it.each([4000, 4001])("enforces the %i-character request boundary on the real server", length => withRooms(async f => {
  f.plan[f.sender.id].steps[0].arguments.message = "x".repeat(length);
  f.plan[f.sender.id].steps[0].expectError = length > 4000;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  if (length > 4000) expect(f.nodes()).toEqual([]);
  else expect(f.nodes().find((n: any) => n.parentId).status).toBe("completed");
}), 45_000);

it("does not turn incidental mentions into extra participants in initiating or dispatched turns", () => withRooms(async f => {
  const observer = (await f.cli("new-bot", "--name", "Observer", "--section", "A")).bot;
  for (const room of [f.source, f.destination]) {
    await f.tool("update_channel", { channel_id: room.id, member_ids: [...room.memberIds, observer.id] });
  }
  f.plan[f.sender.id].reply = "Assigned; @Observer is mentioned only as context";
  f.plan[f.sender.id].resumeReply = "Reviewed; @Observer is mentioned only as context";
  f.plan[f.target.id].reply = "Built CSV; @Observer is mentioned only as context";
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, f.sender.id]);
  expect(f.nodes().every((n: any) => n.status === "completed")).toBe(true);
}), 45_000);

it("returns a provider failure to the sender and resumes it to handle the failure", () => withRooms(async f => {
  f.plan[f.target.id].fail = true;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((n: any) => n.parentId);
  expect(child.status).toBe("failed");
  const source = await f.messages(f.source.activeTaskId);
  expect(source.some((m: any) => m.roomRequest?.phase === "result" && m.tool?.name.includes("couldn't finish"))).toBe(true);
  expect(source.some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
}), 45_000);

it("receipts a retried duplicate of a failed hand-off as failed, not queued behind a resume that never comes", () => withRooms(async f => {
  f.plan[f.target.id].fail = true;
  f.plan[f.sender.id].resumeSteps = [{ arguments: f.plan[f.sender.id].steps[0].arguments, expectError: true }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, f.sender.id]);
  const [assigned, retried] = f.provider().filter((turn: any) => turn.botId === f.sender.id);
  expect(assigned.resumed).toBe(false);
  const first = JSON.parse(assigned.evidence.find((entry: any) => entry.step).response.result.content[0].text);
  expect(first.receipts[0]).toMatchObject({ botId: f.target.id, outcome: "queued" });
  expect(retried.resumed).toBe(true);
  const retry = retried.evidence.find((entry: any) => entry.step).response.result;
  expect(retry.isError).toBe(true);
  expect(retry.content[0].text).toContain("not sent again: it failed; send it with rework=true to retry");
  expect(f.nodes().filter((n: any) => n.parentId)).toHaveLength(1);
}), 45_000);

it("keeps a busy recipient queued and rejects revoked peer access before dispatch", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 2000;
  f.savePlan();
  await f.cli("send", "--bot", f.target.id, "--text", "Independent direct task");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((n: any) => n.parentId).status).toBe("failed");
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  await f.cli("wait", "--bot", f.target.id, "--timeout", "15");
}), 45_000);

it("stops an active downstream turn when the source group is interrupted", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 10_000;
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("running");
  await f.cli("interrupt", "--channel", f.source.id);
  await expect.poll(async () => {
    const { bots } = await f.api("/api/bots"); return bots.find((b: any) => b.id === f.target.id)?.busy;
  }, { timeout: 15_000 }).toBeFalsy();
  expect(f.nodes().every((n: any) => n.status === "cancelled")).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(false);
}), 45_000);

it.each(["allow", "deny"])("honors %s on the sender's peer-approval card", behavior => withRooms(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { approvePeerComms: true }, "PATCH");
  f.plan[f.sender.id].steps[0].expectError = behavior === "deny";
  await f.start();
  let card: any;
  await expect.poll(async () => {
    card = (await f.messages(f.source.activeTaskId)).find((m: any) => m.card?.tool === "delegate_bot");
    return Boolean(card);
  }, { timeout: 10_000 }).toBe(true);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  expect((await f.cli("wait", "--channel", f.source.id, "--timeout", "3")).status).toBe("needs-user");
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: card.card.requestId, behavior });
  expect((await f.wait()).status).toBe("settled");
  if (behavior === "deny") expect(f.nodes()).toEqual([]);
  else expect(f.nodes().find((n: any) => n.parentId)).toMatchObject({ status: "completed", approvalGranted: true });
}), 45_000);

it.each(["allow", "deny"])("presents all peer approvals together and dispatches only if every recipient is allowed (%s)", behavior => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.destination.id, member_ids: [f.target.id, reviewer.id] });
  await f.api(`/api/bots/${f.sender.id}`, { approvePeerComms: true }, "PATCH");
  f.plan[reviewer.id] = { reply: "Reviewed CSV" };
  f.plan[f.sender.id].steps[0].arguments.bot_ids.push(reviewer.id);
  f.plan[f.sender.id].steps[0].expectError = behavior === "deny";
  await f.start();
  let cards: any[] = [];
  await expect.poll(async () => {
    cards = (await f.messages(f.source.activeTaskId)).filter((m: any) => m.card?.tool === "delegate_bot");
    return cards.length;
  }, { timeout: 10_000 }).toBe(2);
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: cards[1].card.requestId, behavior });
  expect(f.nodes()).toEqual([]);
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: cards[0].card.requestId, behavior: "allow" });
  expect((await f.wait()).status).toBe("settled");
  if (behavior === "deny") expect(f.nodes()).toEqual([]);
  else expect(f.nodes().filter((n: any) => n.parentId)).toMatchObject([
    { status: "completed", approvalGranted: true }, { status: "completed", approvalGranted: true },
  ]);
  const posted = (await f.messages(f.destination.activeTaskId)).filter((m: any) => m.roomRequest?.phase === "request");
  expect(posted).toHaveLength(behavior === "deny" ? 0 : 1);
  if (behavior === "allow") expect(posted[0].text).toBe("@Engineer @Reviewer Please build CSV");

}), 45_000);

it("pins a busy destination's task even when its active task changes", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 1500;
  f.savePlan(); await f.cli("send", "--bot", f.target.id, "--text", "Independent work");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  const created = await f.tool("create_task", { target_type: "channel", target_id: f.destination.id, title: "Unrelated conversation" });
  expect((await f.wait()).status).toBe("settled");
  const nodes = f.nodes(); expect(nodes.find((n: any) => n.parentId).threadId).toBe(f.destination.activeTaskId);
  expect((await f.messages(f.destination.activeTaskId)).some((m: any) => m.text === "Built CSV")).toBe(true);
  const current = (await f.api("/api/bots")).groups.find((g: any) => g.id === f.destination.id);
  expect(current.threadId).not.toBe(f.destination.activeTaskId);
  expect(await f.messages(current.threadId)).toEqual([]);
  expect(created.success).toBe(true);
}), 45_000);
it("consults multiple existing members and returns once, with no discussion prerequisite or new room settings", () => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, reviewer.id] });
  f.plan[f.sender.id].steps = [{ arguments: { bot_ids: [f.target.id, reviewer.id], message: "Give one risk from your role" } }];
  f.plan[reviewer.id] = { reply: "Privacy risk" };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, reviewer.id, f.sender.id]);
  const source = await f.messages(f.source.activeTaskId);
  expect(source.filter((m: any) => m.comm).map((m: any) => m.comm.withBotId)).toEqual([f.target.id, reviewer.id]);
  expect(source.filter((m: any) => m.text === "Reviewed downstream outcome")).toHaveLength(1);
  const requests = source.filter((m: any) => m.roomRequest?.phase === "request");
  expect(requests).toHaveLength(1);
  expect(requests[0].text).toBe("@Engineer @Reviewer Give one risk from your role");
  for (const id of [f.target.id, reviewer.id]) {
    expect(JSON.stringify(f.provider().find((turn: any) => turn.botId === id).prompt).match(/Give one risk from your role/g)).toHaveLength(1);
  }

  const tools = f.provider()[0].evidence[0].result.tools.map((t: any) => t.name);
  expect(tools).toContain("coordinate_bots");
  expect(tools).toContain("request_credential");
  for (const old of ["discuss_room", "assign_room_member", "delegate_bot", "ask_bot", "start_thread"]) expect(tools).not.toContain(old);
}), 45_000);

it.each([false, true])("retains reports behind compact receipts for later turns, unless access is revoked (%s)", revoked => withRooms(async f => {
  const report = "Nora executed python3 -m unittest: 3 tests passed.";
  const firstSteps = f.plan[f.sender.id].steps;
  f.plan[f.sender.id] = { turns: [
    { steps: firstSteps, reply: "Assigned" },
    { reply: "Reviewed downstream outcome" },
    { reply: "Follow-up answered", expectContextIncludes: [revoked ? "Teammate result withheld" : report] },
  ] };
  f.plan[f.target.id].reply = report;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const receipt = (await f.messages(f.source.activeTaskId)).find((m: any) => m.roomRequest?.phase === "result");
  expect(receipt.kind).toBe("activity");
  expect(receipt.text).toBeUndefined();
  if (revoked) await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  await f.cli("send-channel", "--channel", f.source.id, "--text", "Did the reviewer actually run tests? Do not start new work.");
  expect((await f.wait()).status).toBe("settled");
  const followup = f.provider().filter((turn: any) => turn.botId === f.sender.id).at(-1);
  expect(followup.turnIndex).toBe(2);
  expect(JSON.stringify(followup.prompt).includes(report)).toBe(!revoked);
  expect(f.nodes()).toHaveLength(2);
}), 45_000);

it("waits for busy peers and then completes without the user relaying messages", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 1500;
  f.savePlan(); await f.cli("send", "--bot", f.target.id, "--text", "Independent work");
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().every((n: any) => n.status === "completed")).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
}), 45_000);

it.each([
  ["a name nobody has in a bot_ids slot", false],
  ["a hidden teammate's id", true],
] as const)("refuses %s with a message the caller can act on", (_case, hidden) => withRooms(async f => {
  if (hidden) await f.api(`/api/bots/${f.target.id}`, { hidden: true }, "PATCH");
  const botId = hidden ? f.target.id : "Nobody";
  f.plan[f.sender.id].steps = [{ expectError: true, arguments: { group_id: f.destination.id, bot_ids: [botId], message: "Review CSV" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  const refused = f.provider().find((turn: any) => turn.botId === f.sender.id)
    .evidence.find((entry: any) => entry.step).response.result.content[0].text;
  expect(refused).toBe(hidden
    ? `The bot with id "${botId}" is no longer available — call list_bots for the ones you can reach`
    : `No bot with id or name "${botId}" — call list_bots and copy the exact id from the result. ${PEER_ACCESS_HELP}`);
}), 45_000);

it("resolves a unique teammate name in a bot_ids slot, and refuses an ambiguous one", () => withRooms(async f => {
  f.plan[f.sender.id].steps = [{ arguments: { group_id: f.destination.id, bot_ids: [f.target.name], message: "Please build CSV" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const node = f.nodes().find((n: any) => n.parentId);
  expect(node.botId).toBe(f.target.id);
  expect(node.status).toBe("completed");
  expect((await f.messages(f.destination.activeTaskId)).some((m: any) => m.text?.includes("Please build CSV"))).toBe(true);

  const twin = (await f.cli("new-bot", "--name", f.target.name, "--section", "A")).bot;
  expect(twin.id).not.toBe(f.target.id);
  f.plan[f.sender.id] = { steps: [{ expectError: true, arguments: { group_id: f.destination.id, bot_ids: [f.target.name], message: "Review CSV" } }], reply: "Refused" };
  f.savePlan(); await f.cli("send-channel", "--channel", f.source.id, "--text", "@Director Ask again");
  expect((await f.wait()).status).toBe("settled");
  const refused = f.provider().filter((turn: any) => turn.botId === f.sender.id).at(-1)
    .evidence.find((entry: any) => entry.step).response.result.content[0].text;
  expect(refused).toBe(`2 reachable teammates are named "${f.target.name}" — call list_bots and use the id of the one you mean`);
}), 60_000);


it("does not repeat a shared brief or rerun recipients on an identical tool retry", () => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, reviewer.id] });
  const args = { bot_ids: [f.target.id, reviewer.id], message: "Review the release checklist" };
  f.plan[f.sender.id].steps = [{ arguments: args }, { arguments: args }];
  f.plan[reviewer.id] = { reply: "Release checklist reviewed" };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const requests = (await f.messages(f.source.activeTaskId)).filter((m: any) => m.roomRequest?.phase === "request");
  expect(requests).toHaveLength(1);
  expect(requests[0].text).toBe("@Engineer @Reviewer Review the release checklist");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, reviewer.id, f.sender.id]);
}), 45_000);

it("keeps genuinely different room briefs separate", () => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, reviewer.id] });
  f.plan[f.sender.id].steps = [
    { arguments: { bot_ids: [f.target.id], message: "Check the migration" } },
    { arguments: { bot_ids: [reviewer.id], message: "Check the documentation" } },
  ];
  f.plan[reviewer.id] = { reply: "Documentation reviewed" };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const requests = (await f.messages(f.source.activeTaskId)).filter((m: any) => m.roomRequest?.phase === "request");
  expect(requests.map((m: any) => m.text)).toEqual(["@Engineer Check the migration", "@Reviewer Check the documentation"]);
}), 45_000);
