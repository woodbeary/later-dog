import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  const planPath = join(dataDir, "room-plan.json");
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(200);
    return result;
  };
  const turns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const nodes = (): any[] => existsSync(join(dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8")) : [];
  try {
    const sender = (await cli("new-bot", "--name", "Sender", "--section", "Operations")).bot;
    const recipient = (await cli("new-bot", "--name", "Recipient", "--section", "Operations")).bot;
    await api("PATCH", `/api/bots/${sender.id}`, { chiefOfStaff: true, managedSections: ["Operations"], acknowledgePeerScope: true });
    const plan: Record<string, any> = {};
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    const send = (bot: any, text: string) => cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    const wait = (bot: any) => cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30");
    const note = (text: string) => ({ arguments: { bot_ids: [recipient.id], message: text, reply: "none" } });
    await test({ session, dataDir, cli, api, sender, recipient, plan, save, send, wait, note, turns, nodes });
  } finally { await session.close(); }
}

const told = (turn: any) => JSON.stringify(turn.prompt);
const receipts = (turn: any) => turn.evidence.filter((entry: any) => entry.step)
  .map((entry: any) => JSON.parse(entry.response.result.content[0].text));

it("keeps an idle recipient idle, saves truthful receipts and batches notes into its next real turn", () => fixture(async f => {
  f.plan[f.sender.id] = { steps: [f.note("CONTEXT_ALPHA"), f.note("CONTEXT_BETA"), f.note("CONTEXT_GAMMA"), f.note("CONTEXT_ALPHA")], reply: "Context saved" };
  f.plan[f.recipient.id] = { reply: "Real request handled", expectContextIncludes: ["CONTEXT_ALPHA", "CONTEXT_BETA", "CONTEXT_GAMMA", "ACTUAL_OWNER_REQUEST"] };
  f.save();
  await f.send(f.sender, "Save these notes for the recipient");
  expect((await f.wait(f.sender)).status).toBe("settled");
  const readRecipient = async () => (await f.api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.recipient.id);
  expect(f.turns().filter((turn: any) => turn.botId === f.recipient.id)).toEqual([]);
  expect(await readRecipient()).toMatchObject({ busy: false, waitingForTeammates: false });
  const pending = f.nodes().filter((node: any) => node.parentId && node.botId === f.recipient.id);
  expect(pending).toHaveLength(3);
  expect(pending.every((node: any) => node.contextOnly && node.status === "completed" && node.contextAt === undefined && node.executions === 0)).toBe(true);
  const sourceTurn = f.turns().find((turn: any) => turn.botId === f.sender.id);
  const delivered = receipts(sourceTurn).flatMap((result: any) => result.receipts);
  expect(delivered.map((receipt: any) => receipt.outcome)).toEqual(["saved", "saved", "saved", "saved"]);
  expect(delivered.every((receipt: any) => receipt.detail.includes("next turn") && receipt.detail.includes("no turn started"))).toBe(true);
  expect(delivered[3].requestId).toBe(delivered[0].requestId);
  expect(delivered[3].detail).toContain("already saved");
  await f.send(f.recipient, "ACTUAL_OWNER_REQUEST");
  expect((await f.wait(f.recipient)).status).toBe("settled");
  const actual = f.turns().filter((turn: any) => turn.botId === f.recipient.id);
  expect(actual).toHaveLength(1);
  for (const marker of ["CONTEXT_ALPHA", "CONTEXT_BETA", "CONTEXT_GAMMA"]) expect(told(actual[0])).toContain(marker);
  expect(f.nodes().filter((node: any) => node.contextOnly).every((node: any) => typeof node.contextAt === "number")).toBe(true);
  const messages = (await f.api("GET", `/api/threads/${f.recipient.activeTaskId}/messages?limit=200`)).messages;
  expect(messages.filter((message: any) => message.text?.includes("CONTEXT_ALPHA"))).toHaveLength(1);
  const senderMessages = (await f.api("GET", `/api/threads/${f.sender.activeTaskId}/messages?limit=200`)).messages;
  expect(senderMessages.some((message: any) => message.roomRequest?.phase === "result")).toBe(false);
}), 60_000);

it("keeps notes out of an occupied dog's work queue and delivers them together with the queued real request", () => fixture(async f => {
  const gate = join(f.dataDir, "recipient.gate");
  const ready = join(f.dataDir, "recipient.ready");
  f.plan[f.recipient.id] = { turns: [
    { gateFile: gate, readyFile: ready, reply: "Existing work complete" },
    { reply: "Queued real work complete", expectContextIncludes: ["BUSY_CONTEXT_ONE", "BUSY_CONTEXT_TWO", "QUEUED_REAL_WORK"] },
  ] };
  f.plan[f.sender.id] = { steps: [f.note("BUSY_CONTEXT_ONE"), f.note("BUSY_CONTEXT_TWO"),
    { arguments: { bot_ids: [f.recipient.id], message: "QUEUED_REAL_WORK" } }], reply: "Real work requested", resumeReply: "Result received" };
  f.save();
  await f.send(f.recipient, "Existing real work");
  await expect.poll(() => existsSync(ready), { timeout: 20_000 }).toBe(true);
  await f.send(f.sender, "Pass on context and request real work");
  await expect.poll(() => f.turns().filter((turn: any) => turn.botId === f.sender.id).length, { timeout: 20_000 }).toBe(1);
  const incoming = f.nodes().filter((node: any) => node.parentId && node.botId === f.recipient.id);
  expect(incoming.filter((node: any) => node.status === "queued").map((node: any) => node.text)).toEqual(["QUEUED_REAL_WORK"]);
  expect(incoming.filter((node: any) => node.contextOnly)).toHaveLength(2);
  expect(incoming.filter((node: any) => node.contextOnly).every((node: any) => node.contextAt === undefined)).toBe(true);
  expect(receipts(f.turns().find((turn: any) => turn.botId === f.sender.id)).flatMap((result: any) => result.receipts).map((receipt: any) => receipt.outcome))
    .toEqual(["saved", "saved", "queued"]);
  writeFileSync(gate, "finish existing work");
  expect((await f.wait(f.sender)).status).toBe("settled");
  await expect.poll(() => f.turns().filter((turn: any) => turn.botId === f.recipient.id).length, { timeout: 20_000 }).toBe(2);
  const actual = f.turns().filter((turn: any) => turn.botId === f.recipient.id);
  expect(told(actual[0])).not.toContain("BUSY_CONTEXT_ONE");
  expect(told(actual[1])).toContain("BUSY_CONTEXT_ONE");
  expect(told(actual[1])).toContain("BUSY_CONTEXT_TWO");
  expect(told(actual[1])).toContain("QUEUED_REAL_WORK");
  expect(f.turns().filter((turn: any) => turn.botId === f.sender.id)).toHaveLength(2);
  const senderMessages = (await f.api("GET", `/api/threads/${f.sender.activeTaskId}/messages?limit=200`)).messages;
  expect(senderMessages.filter((message: any) => message.roomRequest?.phase === "result")).toHaveLength(1);
}), 75_000);
