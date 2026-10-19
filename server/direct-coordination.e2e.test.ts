import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { request } from "../scripts/mcp-server.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const told = (turn: any): string => {
  const content = turn.prompt?.message?.content;
  return `${turn.system}\n${typeof content === "string" ? content : JSON.stringify(content ?? "")}`;
};

async function fixture(test: (f: any) => Promise<void>, fakeEnv: NodeJS.ProcessEnv = {}) {
  const desktopOwner = fakeEnv.LATERDOG_TEST_DESKTOP_OWNER_TOKEN;
  const realFetch = globalThis.fetch;
  if (desktopOwner) globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-laterdog-desktop-owner": desktopOwner } });
  try { await fixtureSession(test, fakeEnv); } finally { globalThis.fetch = realFetch; }
}

async function fixtureSession(test: (f: any) => Promise<void>, fakeEnv: NodeJS.ProcessEnv) {
  const session = await launchVerificationServer({ ...process.env, ...fakeEnv }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Engineering lead", "--section", "Engineering")).bot;
    const specialist = (await cli("new-bot", "--name", "Reviewer", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [chief.id]: { steps: [{ arguments: { bot_ids: [lead.id], message: "Implement and independently verify the CSV export" } }], reply: "Assigned to Engineering", resumeReply: "The requested CSV export is implemented and verified" },
      [lead.id]: { steps: [{ arguments: { bot_ids: [specialist.id], message: "Independently verify the CSV export" } }], reply: "Sent for verification", resumeReply: "Implemented and reviewer confirmed checks" },
      [specialist.id]: { reply: "CSV boundary cases verified" },
    };
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    const nodes = () => existsSync(join(session.info.dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8")) : [];
    const evidence = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const start = async () => { save(); return cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Please have Engineering build and independently verify a CSV export. Own the result."); };
    const wait = () => cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30");
    await test({ session, cli, api, chief, lead, specialist, plan, save, start, wait, nodes, evidence, messages });
  } finally { await session.close(); }
}

it("sends cross-bot work onward without resuming either sender", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "sent-work-ready");
  f.plan[f.chief.id] = { steps: [{ tool: "send_to_bot", arguments: {
    bot_id: f.lead.id, title: "Release owner", message: "Own the release and send final QA to Reviewer.",
  } }], reply: "Release sent" };
  f.plan[f.lead.id] = { steps: [{ tool: "send_to_bot", arguments: {
    bot_id: f.specialist.id, title: "Release QA", message: "Own final release QA.",
  } }], reply: "QA sent onward" };
  f.plan[f.specialist.id] = { gateFile: gate, reply: "Release QA complete" };

  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const leadSend = () => f.evidence().find((turn: any) => turn.botId === f.lead.id)?.evidence
    .find((entry: any) => entry.step?.tool === "send_to_bot")?.response.result;
  await expect.poll(leadSend, { timeout: 15_000 }).toBeTruthy();
  expect(leadSend().isError).toBeFalsy();
  await expect.poll(async () => (await f.api("/api/bots?messages=0")).bots
    .find((bot: any) => bot.id === f.specialist.id)?.busy, { timeout: 15_000 }).toBe(true);
  await f.api(`/api/bots/${f.lead.id}`, { peers: [] }, "PATCH");
  writeFileSync(gate, "finish detached work");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.specialist.id).length, { timeout: 15_000 }).toBe(1);
  const bots = (await f.api("/api/bots")).bots;
  const leadThread = bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.title === "Release owner");
  const qaThread = bots.find((bot: any) => bot.id === f.specialist.id).tasks.find((task: any) => task.title === "Release QA");
  const qaMessages = await f.messages(qaThread.threadId);
  expect(qaMessages.some((message: any) => message.text === "Release QA complete")).toBe(true);
  expect(qaMessages.some((message: any) => message.tool?.name?.includes("Send failed"))).toBe(false);
  expect((await f.messages(leadThread.threadId)).some((message: any) => message.text?.includes("Release QA complete"))).toBe(false);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text?.includes("QA sent") || message.text?.includes("Release QA complete"))).toBe(false);
}), 60_000);

it("marks a failed one-way send so restart recovery cannot duplicate its notice", () => fixture(async f => {
  f.plan[f.chief.id] = { steps: [{ tool: "send_to_bot", arguments: {
    bot_id: f.lead.id, title: "Failing work", message: "Try the task", request_key: "failed-send",
  } }], reply: "Sent" };
  f.plan[f.lead.id] = { fail: true };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const failureNotice = async () => {
    const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
    const task = lead?.tasks.find((item: any) => item.title === "Failing work");
    if (!task) return null;
    const messages = await f.messages(task.threadId);
    return messages.find((message: any) => message.tool?.name?.startsWith("Send failed")) ?? null;
  };
  await expect.poll(failureNotice, { timeout: 15_000 }).toBeTruthy();
  expect((await failureNotice())?.tool?.handoffId).toEqual(expect.any(String));
}), 45_000);

it("respects a specialist's explicit peer restriction when contacting its Chief", () => fixture(async f => {
  await f.api(`/api/bots/${f.lead.id}`, { peers: [] }, "PATCH");
  f.plan[f.lead.id] = {
    steps: [{ expectError: true, arguments: { bot_ids: [f.chief.id], message: "Contact the Chief without a shared room" } }],
    reply: "The direct request was refused",
  };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "Check the direct peer boundary");
  expect((await f.cli("wait", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--timeout", "30")).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  const response = f.evidence().find((turn: any) => turn.botId === f.lead.id).evidence.find((entry: any) => entry.step).response;
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain("not an allowed peer");
  expect((await f.api("/api/bots")).groups).toEqual([]);
}), 45_000);

it.each([false, true])("starts independent work immediately and frees the Chief while waiting (source fails: %s)", fail => fixture(async f => {
  const sourceGate = join(f.session.info.dataDir, "source-ready");
  const childGate = join(f.session.info.dataDir, "child-ready");
  f.plan[f.chief.id].gateFile = sourceGate;
  f.plan[f.chief.id].fail = fail;
  f.plan[f.lead.id] = { gateFile: childGate, reply: "CSV export implemented and checked", expectContextIncludes: ["[LIVE TEAMMATES]", `[id: ${f.specialist.id}]`] };
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  expect(f.nodes().find((n: any) => n.botId === f.chief.id).status).toBe("source");
  writeFileSync(sourceGate, "finish the fixture source turn");
  const readChief = async () => (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.id === f.chief.id);
  await expect.poll(async () => {
    const b = await readChief();
    return !b.busy && b.waitingForTeammates && b.tasks.find((t: any) => t.threadId === f.chief.activeTaskId)?.waitingForTeammates;
  }, { timeout: 30_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.chief.activeTaskId}`, { approvalMode: "ask" }, "PATCH");
  expect(f.nodes().find((n: any) => n.botId === f.lead.id).status).toBe("running");
  writeFileSync(childGate, "complete the fixture teammate");
  await expect.poll(() => f.nodes().find((n: any) => n.botId === f.chief.id)?.status, { timeout: 15_000 }).toBe("completed");
  expect((await f.wait()).status).toBe("settled");
  expect((await f.messages(f.chief.activeTaskId)).filter((m: any) => m.text === f.plan[f.chief.id].resumeReply)).toHaveLength(1);
  await expect.poll(async () => {
    const b = await readChief();
    return { busy: b.busy, waitingForTeammates: b.waitingForTeammates };
  }, { timeout: 15_000 }).toEqual({ busy: false, waitingForTeammates: false });
}), 60_000);

it("coordinates a lead and its specialist from ordinary chat in each dog's one conversation and returns to Clive", () => fixture(async f => {
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
  expect(f.nodes().every((node: any) => !node.groupId && node.status === "completed")).toBe(true);
  expect((await f.api("/api/bots")).groups).toEqual([]);
  expect(f.nodes().find((node: any) => node.botId === f.lead.id).threadId).toBe(f.lead.activeTaskId);
  expect(f.nodes().find((node: any) => node.botId === f.specialist.id).threadId).toBe(f.specialist.activeTaskId);
  expect((await f.messages(f.lead.activeTaskId)).some((message: any) => message.text?.includes("Implement and independently verify the CSV export"))).toBe(true);
  expect((await f.messages(f.specialist.activeTaskId)).some((message: any) => message.text === "CSV boundary cases verified")).toBe(true);
  const receipt = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.tool?.name === "Sent to Engineering lead");
  expect(receipt.threadRef).toMatchObject({ botId: f.lead.id, threadId: f.lead.activeTaskId });
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
  const bots = (await f.api("/api/bots")).bots;
  expect(bots.find((bot: any) => bot.id === f.lead.id).managedSections).toBeUndefined();
  const turn = f.evidence().find((entry: any) => entry.botId === f.lead.id);
  const tools = turn.evidence[0].result.tools.map((tool: any) => tool.name);
  expect(tools).toContain("coordinate_bots");
  expect(tools).not.toContain("delegate_bot");
  expect(tools).not.toContain("start_thread");
  const chiefTools = f.evidence()[0].evidence[0].result.tools.map((tool: any) => tool.name);
  for (const gone of ["start_thread", "list_threads", "close_thread"]) expect(chiefTools).not.toContain(gone);
  expect(bots.find((bot: any) => bot.id === f.lead.id).tasks).toHaveLength(1);
  expect(bots.find((bot: any) => bot.id === f.specialist.id).tasks).toHaveLength(1);
  expect(turn.system).toContain("only an actual coordinate_bots result proves that teammate participated");
}), 45_000);

it("announces a settled delegation and its resume in the parent thread", () => fixture(async f => {
  const stream = await openSse(`${f.session.info.url}/api/events`);
  try {
    await f.start();
    expect((await f.wait()).status).toBe("settled");
    await Promise.all([
      stream.until(frame => frame.kind === "notify"
        && frame.notification?.kind === "delegation-settled"
        && frame.notification.botId === f.chief.id),
      stream.until(frame => frame.kind === "notify"
        && frame.notification?.kind === "delegation-settled"
        && frame.notification.botId === f.lead.id),
    ]);
    const settles = () => stream.frames.filter(frame => frame.kind === "notify" && frame.notification?.kind === "delegation-settled");
    const chiefFrames = settles().filter(frame => frame.notification.botId === f.chief.id);
    expect(chiefFrames).toHaveLength(1);
    expect(chiefFrames[0].notification).toMatchObject({
      threadId: f.chief.activeTaskId,
      title: "Clive resumed with results",
      body: "Results in from Engineering lead",
    });
    const leadFrames = settles().filter(frame => frame.notification.botId === f.lead.id);
    expect(leadFrames).toHaveLength(1);
    expect(leadFrames[0].notification.threadId).toBe(f.lead.activeTaskId);
    expect(settles().some(frame => frame.notification.botId === f.specialist.id)).toBe(false);
    expect(stream.frames.some(frame => frame.kind === "notify" && frame.notification?.kind === "done"
      && (frame.notification.botId === f.lead.id || frame.notification.botId === f.specialist.id))).toBe(false);
    const chips = (await f.messages(f.chief.activeTaskId))
      .filter((message: any) => message.kind === "activity" && message.tool?.name.startsWith("Resumed with "));
    expect(chips.map((message: any) => message.tool.name)).toEqual(["Resumed with Engineering lead results, reviewing"]);
  } finally { stream.close(); }
}), 45_000);

it.each(["resume", "stop", "failed resume", "failed root"] as const)("keeps a guarded Chief request exact through coordination and %s", action => fixture(async f => {
  const threadId = f.chief.activeTaskId;
  const sendId = randomUUID();
  const route = `/api/bots/${f.chief.id}/requests/${sendId}`;
  const gate = join(f.session.info.dataDir, "guarded-coordination.gate");
  const evidence: unknown[] = [{ fixture: f.session.info, action }];
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(f.session.info.url + path, { method,
      headers: { "content-type": "application/json", origin: f.session.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected); return result;
  };
  try {
    await api("PATCH", `/api/bots/${f.chief.id}`, { parkDirectMessages: true });
    await api("PATCH", `/api/bots/${f.chief.id}/tasks/${threadId}`, { approvalMode: "ask" });
    f.plan[f.lead.id] = { gateFile: gate, reply: "The gated CSV export check passed" };
    f.plan[f.chief.id].failResumed = action === "failed resume";
    f.save();
    const before = await api("GET", `/api/threads/${threadId}/messages`);
    const accepted = await api("POST", `/api/bots/${f.chief.id}/messages/guarded`, {
      threadId, sendId, text: "Coordinate the gated CSV export check and own the result.", expectedActiveLeafId: before.activeLeafId,
    }, 202);
    const snapshot = () => api("GET", `${route}?threadId=${threadId}`);
    await expect.poll(async () => {
      const current = await snapshot();
      return current.phase === "waiting" && current.activeTurnId === null &&
        current.messages.some((message: any) => message.text === "Assigned to Engineering" && message.turnTerminal);
    }, { timeout: 15_000 }).toBe(true);
    const waiting = await snapshot();
    expect(waiting).toMatchObject({ messageId: accepted.message.id, phase: "waiting", activeTurnId: null, executionId: expect.any(String) });
    expect(waiting.messages[0]).toMatchObject({ id: accepted.message.id, sendId, role: "user" });
    expect(waiting.messages.at(-1).id).toBe(waiting.activeLeafId);
    expect(waiting.messages.find((message: any) => message.text === "Assigned to Engineering").requestMessageId).toBe(accepted.message.id);
    await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
    const child = f.nodes().find((node: any) => node.botId === f.lead.id);
    await api("PATCH", `/api/bots/${f.chief.id}/tasks/${threadId}`, { approvalMode: "ask" });
    const target = { threadId, messageId: waiting.messageId, expectedActiveLeafId: waiting.activeLeafId,
      expectedTurnId: waiting.activeTurnId, expectedExecutionId: waiting.executionId };
    if (action === "failed root") {
      await api("PATCH", `/api/bots/${f.chief.id}`, { hidden: true });
      await expect.poll(() => f.nodes().find((node: any) => node.id === waiting.executionId)?.status, { timeout: 15_000 }).toBe("failed");
      writeFileSync(gate, "release the isolated teammate after its root failed");
      const finalWait = await f.wait();
      evidence.push({ command: ["wait", "--bot", f.chief.id, "--task", threadId, "--timeout", "30"], result: finalWait });
      expect(finalWait.status).toBe("settled");
      const failed = await snapshot();
      expect(failed).toMatchObject({ messageId: accepted.message.id, phase: "untracked", activeTurnId: null, executionId: waiting.executionId });
      expect(failed.messages[0].requestPending).toBe(true);
      expect(failed.messages[0].requestCancelled).not.toBe(true);
      expect(failed.messages.find((message: any) => message.turnTerminal)).toMatchObject({
        text: "Assigned to Engineering", requestMessageId: accepted.message.id, turnSucceeded: true,
      });
      expect(failed.messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
      evidence.push({ command: ["messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30"],
        result: await f.cli("messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30") });
      return;
    }
    if (action === "stop") {
      await api("POST", `${route}/interrupt`, { ...target, expectedExecutionId: null }, 409);
      expect(await api("POST", `${route}/interrupt`, target)).toEqual({ ok: true, outcome: "stopped" });
      await api("POST", `${route}/interrupt`, target, 409);
      expect(f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("running");
    }
    writeFileSync(gate, "finish only the isolated teammate");
    const childWait = await f.cli("wait", "--bot", f.lead.id, "--task", child.threadId, "--timeout", "20");
    evidence.push({ command: ["wait", "--bot", f.lead.id, "--task", child.threadId, "--timeout", "20"], result: childWait });
    expect(childWait.status).toBe("settled");
    await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("completed");
    const finalWait = await f.wait();
    evidence.push({ command: ["wait", "--bot", f.chief.id, "--task", threadId, "--timeout", "30"], result: finalWait });
    expect(action === "failed resume" ? ["settled", "failed"] : ["settled"]).toContain(finalWait.status);
    if (action === "stop") {
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
      const messages = await f.messages(threadId);
      expect(new Set(messages.filter((message: any) => message.turnId).map((message: any) => message.turnId)).size).toBe(1);
      expect(messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      await api("POST", `${route}/interrupt`, target, 409);
    } else if (action === "failed resume") {
      const failed = await snapshot();
      expect(failed).toMatchObject({ messageId: accepted.message.id, phase: "untracked", activeTurnId: null });
      expect(failed.executionId).not.toBe(waiting.executionId);
      const initial = failed.messages.find((message: any) => message.turnTerminal);
      expect(initial).toMatchObject({ text: "Assigned to Engineering", requestMessageId: accepted.message.id, turnSucceeded: true });
      expect(failed.messages.findLast((message: any) => message.turnSucceeded !== undefined).turnSucceeded).toBe(false);
      expect(failed.messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.chief.id]);
      await api("POST", `${route}/interrupt`, target, 409);
    } else {
      const settled = await snapshot();
      expect(settled).toMatchObject({ messageId: accepted.message.id, phase: "settled", activeTurnId: null, executionId: expect.any(String) });
      expect(settled.executionId).not.toBe(waiting.executionId);
      expect(settled.messages[0].id).toBe(accepted.message.id);
      expect(settled.messages.at(-1).id).toBe(settled.activeLeafId);
      for (let index = 1; index < settled.messages.length; index++) expect(settled.messages[index].parentId).toBe(settled.messages[index - 1].id);
      const replies = settled.messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.turnTerminal);
      expect(replies.map((message: any) => message.text)).toEqual(["Assigned to Engineering", "The requested CSV export is implemented and verified"]);
      expect(new Set(replies.map((message: any) => message.turnId)).size).toBe(2);
      expect(settled.messages.filter((message: any) => message.turnId).every((message: any) => message.requestMessageId === accepted.message.id)).toBe(true);
      expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.chief.id]);
      await api("POST", `${route}/interrupt`, target, 409);
    }
    evidence.push({ command: ["messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30"],
      result: await f.cli("messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30") });
  } finally {
    const evidencePath = `${f.session.info.logPath}.guarded-coordination-${action.replaceAll(" ", "-")}.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: f.session.info.logPath }));
  }
}), 45_000);

it("uses only the coordinator for teammates and keeps the result in the teammate's one conversation", () => fixture(async f => {
  f.plan[f.chief.id].steps.unshift({ tool: "start_thread", arguments: { bot_id: f.lead.id, title: "Wrong path", message: "Use teamwork" }, expectError: true });
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(1);
  const rejected = f.evidence()[0].evidence.find((entry: any) => entry.step?.tool === "start_thread");
  expect(rejected.response.error.message).toBe("Unknown tool: start_thread");
  expect((await f.messages(f.lead.activeTaskId)).some((message: any) => message.text === "Implemented and reviewer confirmed checks")).toBe(true);
}), 45_000);

it("returns a nested coordinated result after Claude retries a transient provider exit", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-coordination-retry-"));
  try {
    await fixture(async f => {
      await f.start();
      expect((await f.wait()).status).toBe("settled");
      expect(f.nodes()).toHaveLength(3);
      expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
      expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
      expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
      expect(Number(readFileSync(join(scratch, "launches"), "utf8"))).toBeGreaterThan(5);
    }, { FAKE_CLAUDE_TRANSIENTS: "1", FAKE_CLAUDE_STATE: join(scratch, "launches"), FAKE_CLAUDE_RETRY_SCALE: "0.001" });
  } finally { await removeTempDir(scratch); }
}, 45_000);

it("returns nested results after Claude rejects the source's prior resume cursor", () => fixture(async f => {
  const coordination = f.plan[f.chief.id];
  f.plan[f.chief.id] = { reply: "Earlier conversation" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Hello before the task");
  expect((await f.wait()).status).toBe("settled");
  f.plan[f.chief.id] = coordination;
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toHaveLength(3);
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
  const transcript = await f.messages(f.chief.activeTaskId);
  expect(transcript.some((message: any) => message.tool?.name?.includes("resume_rejected"))).toBe(true);
}, { FAKE_CLAUDE_MODE: "dead-session", FAKE_CLAUDE_EXIT_AFTER_TURN: "1" }), 45_000);

it("runs teammate work on the recipient's own model and level, never the sender's", () => fixture(async f => {
  const models = await f.cli("models");
  const options = models.instances.find((instance: any) => instance.instanceId === f.chief.modelSelection.instanceId).models.options;
  const selected = options.find((model: any) => model.id !== f.chief.modelSelection.model);
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.chief.activeTaskId}`, { modelSelection: { instanceId: f.chief.modelSelection.instanceId, model: selected.id }, approvalMode: "edits" }, "PATCH");
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(1);
  expect(lead.tasks[0].approvalMode ?? "ask").toBe("ask");
  expect((await f.messages(f.lead.activeTaskId)).some((message: any) => /delegated by/.test(message.tool?.name ?? ""))).toBe(false);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).every((turn: any) => turn.model === f.lead.modelSelection.model && turn.permissionMode === "auto")).toBe(true);
}), 45_000);

const sendReceipts = (f: any, botId: string) => f.evidence().filter((turn: any) => turn.botId === botId)
  .flatMap((turn: any) => turn.evidence.filter((entry: any) => entry.step))
  .map((entry: any) => JSON.parse(entry.response.result.content[0].text).receipts[0]);

it("sends every follow-up to the recipient's one conversation", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Header row added" }, { reply: "Write-up published" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned the build" },
    { reply: "The export is implemented" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Add the header row to that export" } }], reply: "Assigned the header row" },
    { reply: "The header row is in" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Document the export you just built" } }], reply: "Assigned the write-up" },
    { reply: "It is documented" },
  ] };
  f.save();
  const send = async (text: string) => {
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", text);
    expect((await f.wait()).status).toBe("settled");
  };
  const leadTasks = async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks;
  await send("Ask Engineering to build the CSV export.");
  await send("Now ask them to add the header row.");
  await send("Now ask them to document it.");
  const main = f.lead.activeTaskId;
  const tasks = await leadTasks();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).not.toHaveProperty("closedBy");
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId)).toEqual([main, main, main]);
  const briefs = ["Implement the CSV export", "Add the header row to that export", "Document the export you just built"];
  const transcript = (await f.messages(main)).map((message: any) => message.text).filter(Boolean).join("\n");
  for (const brief of briefs) expect(transcript).toContain(brief);
  const leadTurns = f.evidence().filter((turn: any) => turn.botId === f.lead.id);
  expect(leadTurns.map((turn: any) => turn.threadId)).toEqual([main, main, main]);
  for (const [index, brief] of briefs.entries()) expect(leadTurns[index].prompt.message.content).toContain(brief);
  expect(leadTurns.every((turn: any) => turn.system.includes("current request and returned results arrive in the user turn"))).toBe(true);
  expect(leadTurns.every((turn: any) => turn.snapshotMode === "off")).toBe(true);
  for (const brief of briefs) expect(leadTurns.every((turn: any) => !turn.system.includes(brief))).toBe(true);
  const receipts = sendReceipts(f, f.chief.id);
  expect(receipts.map((receipt: any) => receipt.threadId)).toEqual([main, main, main]);
  for (const receipt of receipts) expect(receipt.detail).toBe("sent to Engineering lead's conversation; it runs after anything still running there");
  const chips = (await f.messages(f.chief.activeTaskId)).filter((message: any) => message.threadRef?.threadId === main);
  expect(chips.filter((message: any) => message.tool?.name === "Sent to Engineering lead")).toHaveLength(3);
}, { FAKE_CLAUDE_VERSION: "2.1.270" }), 90_000);

it.each<[string, NodeJS.ProcessEnv]>([
  ["a headless server", {}],
  ["the desktop app", { LATERDOG_TEST_DESKTOP_OWNER_TOKEN: randomBytes(32).toString("base64url") }],
])("on %s, holds a follow-up sent while the teammate still works and runs it next in the same thread", (_where, env) => fixture(async f => {
  expect((await f.api("/.well-known/laterdog/environment", undefined, "GET")).capabilities.selfUpdate)
    .toBe(env.LATERDOG_TEST_DESKTOP_OWNER_TOKEN ? "desktop-managed" : "operator");
  const gate = join(f.session.info.dataDir, "first-request.gate");
  f.plan[f.lead.id] = { turns: [{ gateFile: gate, reply: "Export implemented" }, { reply: "Header row added" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned the build" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Also add a header row to that export" } }], reply: "Sent the change" },
    { reply: "Reviewed" },
    { reply: "Reviewed" },
  ] };
  const chiefTurns = () => f.evidence().filter((turn: any) => turn.botId === f.chief.id);
  const stream = await openSse(`${f.session.info.url}/api/events`);
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await expect.poll(() => chiefTurns().length, { timeout: 15_000 }).toBe(1);
  await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Change of plan: the export also needs a header row.", threadId: f.chief.activeTaskId });
  await expect.poll(() => chiefTurns().length, { timeout: 20_000 }).toBe(2);
  expect(told(chiefTurns()[1])).toContain("send the change to the same teammate with coordinate_bots");
  const [running, followUp] = f.nodes().filter((node: any) => node.botId === f.lead.id);
  expect(followUp.threadId).toBe(running.threadId);
  expect(sendReceipts(f, f.chief.id)[1]).toMatchObject({ outcome: "queued", threadId: running.threadId });
  await new Promise(resolve => setTimeout(resolve, 1_500));
  expect(f.nodes().find((node: any) => node.id === followUp.id).status).toBe("queued");
  expect(f.nodes().find((node: any) => node.id === running.id).status).toBe("running");
  writeFileSync(gate, "go");
  expect((await f.wait()).status).toBe("settled");
  await expect.poll(() => f.nodes().filter((node: any) => node.parentId).every((node: any) => node.status === "completed"), { timeout: 15_000 }).toBe(true);
  const leadTurns = f.evidence().filter((turn: any) => turn.botId === f.lead.id);
  expect(leadTurns.map((turn: any) => [turn.turnIndex, turn.threadId])).toEqual([[0, f.lead.activeTaskId], [1, f.lead.activeTaskId]]);
  expect((await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks).toHaveLength(1);
  stream.close();
  expect(stream.frames.some(frame => frame.kind === "bot" && frame.bot?.id === f.lead.id && frame.bot.tasks?.some((task: any) => task.closedBy))).toBe(false);
}, env), 60_000);

it("runs two assignments to one teammate from one turn in its conversation, one after the other", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Benchmark finished" }] };
  f.plan[f.chief.id] = { steps: [
    { arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } },
    { arguments: { bot_ids: [f.lead.id], message: "Benchmark the exporter on the large fixture" } },
  ], reply: "Both assignments are out", resumeReply: "Both came back" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const tasks = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks;
  expect(tasks).toHaveLength(1);
  const main = f.lead.activeTaskId;
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId)).toEqual([main, main]);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => [turn.turnIndex, turn.threadId]))
    .toEqual([[0, main], [1, main]]);
  const transcript = (await f.messages(main)).map((message: any) => message.text).filter(Boolean).join("\n");
  expect(transcript).toContain("Implement the CSV export");
  expect(transcript).toContain("Benchmark the exporter");
}), 60_000);

it("sends work from another conversation of the same Chief to the teammate's one conversation", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Invoices exported" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned" },
    { reply: "Done" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Export the invoices" } }], reply: "Assigned" },
    { reply: "Done" },
  ] };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const other = (await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Invoices" })).task.threadId;
  await f.cli("send", "--bot", f.chief.id, "--task", other, "--text", "Ask Engineering to export the invoices.");
  expect((await f.cli("wait", "--bot", f.chief.id, "--task", other, "--timeout", "30")).status).toBe("settled");
  expect((await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks).toHaveLength(1);
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId)).toEqual([f.lead.activeTaskId, f.lead.activeTaskId]);
  const transcript = (await f.messages(f.lead.activeTaskId)).map((message: any) => message.text).filter(Boolean).join("\n");
  expect(transcript).toContain("Implement the CSV export");
  expect(transcript).toContain("Export the invoices");
}), 60_000);

it("runs an identical call made twice in one turn once", () => fixture(async f => {
  f.plan[f.chief.id].steps.push(structuredClone(f.plan[f.chief.id].steps[0]));
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id)).toHaveLength(1);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(1);
  expect((await f.messages(f.chief.activeTaskId)).filter((message: any) => message.tool?.name === "Sent to Engineering lead")).toHaveLength(1);
  const [sent, repeated] = sendReceipts(f, f.chief.id);
  expect(repeated).toMatchObject({ requestId: sent.requestId, threadId: sent.threadId });
  expect(repeated.detail).toContain("already sent");
}), 45_000);

it.each<[string, Record<string, unknown>, string]>([
  ["finished", { reply: "3 tests fail" }, "not sent again: it already finished and its result stands; send it with rework=true to run it again"],
  ["failed", { fail: true }, "not sent again: it failed; send it with rework=true to retry"],
])("runs an identical brief again only with rework=true once its first run %s", (how, firstRun, refusal) => fixture(async f => {
  const brief = "Run the full test suite and report every failure";
  f.plan[f.lead.id] = { turns: [firstRun, { reply: "All tests pass" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: brief } }], reply: "Sent" },
    { steps: [
      { arguments: { bot_ids: [f.lead.id], message: brief }, expectError: true },
      ...(how === "finished" ? [{ arguments: { bot_ids: [f.lead.id], message: "Thanks, approved" }, expectError: true }] : []),
      { arguments: { bot_ids: [f.lead.id], message: brief, rework: true } },
    ], reply: "Sent again" },
    { reply: "The suite is green" },
  ] };
  await f.start();
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 30_000 }).toBe(3);
  expect((await f.wait()).status).toBe("settled");
  const results = f.evidence().filter((turn: any) => turn.botId === f.chief.id)
    .flatMap((turn: any) => turn.evidence.filter((entry: any) => entry.step)).map((entry: any) => entry.response.result);
  const [sent, repeated] = results;
  const rerun = results.at(-1);
  expect(repeated.isError).toBe(true);
  expect(repeated.content[0].text).toContain(refusal);
  if (how === "finished") expect(results[2].content[0].text).toContain("Only use rework=true for concrete additional work.");
  const [first, again] = [sent, rerun].map((result: any) => JSON.parse(result.content[0].text).receipts[0]);
  expect(again).toMatchObject({ outcome: "queued", threadId: first.threadId });
  expect(again.requestId).not.toBe(first.requestId);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => turn.threadId)).toEqual([first.threadId, first.threadId]);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The suite is green")).toBe(true);
}), 60_000);

it("runs teammate work after the recipient finishes what it is already doing in its conversation", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "unrelated-work.gate");
  f.plan[f.lead.id] = { turns: [{ gateFile: gate, progress: "Unrelated work started", reply: "Unrelated work completed" }, { reply: "Coordinated work completed" }] };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "My unrelated task");
  try {
    await expect.poll(async () => (await f.messages(f.lead.activeTaskId)).some((m: any) => m.text === "Unrelated work started"), { timeout: 10_000 }).toBe(true);
    await f.start();
    await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 8_000 }).toBe("queued");
    writeFileSync(gate, "go");
    await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 15_000 }).toBe("completed");
    expect((await f.wait()).status).toBe("settled");
    const texts = (await f.messages(f.lead.activeTaskId)).map((m: any) => m.text);
    expect(texts.indexOf("Unrelated work completed")).toBeLessThan(texts.indexOf("Coordinated work completed"));
    expect((await f.messages(f.chief.activeTaskId)).some((m: any) => m.text === "The requested CSV export is implemented and verified")).toBe(true);
  } finally {
    writeFileSync(gate, "go");
  }
}), 45_000);

it("queues a recipient at capacity, preserving its existing task and resuming only the pinned parent", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PUT");
  f.plan[f.lead.id] = { turns: [{ delayMs: 2500, reply: "Unrelated work completed" }, { reply: "Coordinated work completed" }] };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "My unrelated task");
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  await expect.poll(async () => {
    const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
    return { busy: chief.busy, waitingForTeammates: chief.waitingForTeammates };
  }, { timeout: 15_000 }).toEqual({ busy: false, waitingForTeammates: true });
  const next = await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Other conversation" });
  expect((await f.wait()).status).toBe("settled");
  expect(await f.messages(next.task.threadId)).toEqual([]);
  expect((await f.messages(f.lead.activeTaskId)).some((message: any) => message.text === "Unrelated work completed")).toBe(true);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => turn.threadId)).toEqual([f.lead.activeTaskId, f.nodes().find((node: any) => node.botId === f.lead.id).threadId]);
}), 45_000);

it("runs a message sent while a teammate works, keeps the assignment, and names it in that turn", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 4000, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "Noted; Engineering is still working on it" },
    { reply: "The requested CSV export is implemented and verified" },
  ] };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  const receipt = await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Also make sure the export is UTF-8.", threadId: f.chief.activeTaskId });
  expect(receipt.queued).toBeUndefined();
  expect(receipt.message.text).toBe("Also make sure the export is UTF-8.");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 20_000 }).toBe(2);

  const steered = f.evidence().filter((turn: any) => turn.botId === f.chief.id)[1];
  expect(steered.resumed).toBe(false);
  expect(told(steered)).toContain("Assignments you already sent are still outstanding");
  expect(told(steered)).toContain(assignment.id);
  expect(told(steered)).toContain("Engineering lead");
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).not.toBe("cancelled");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
}), 60_000);

it("parks a message behind outstanding teammate work when the bot opts in, then runs it after", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 8000, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "The requested CSV export is implemented and verified" },
    { reply: "Noted; the export is UTF-8 too" },
  ] };
  await f.api(`/api/bots/${f.chief.id}`, { parkDirectMessages: true }, "PATCH");
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  const receipt = await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Also make sure the export is UTF-8.", threadId: f.chief.activeTaskId });
  expect(receipt.queued).toBe(true);
  expect(typeof receipt.queueId).toBe("string");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Also make sure the export is UTF-8.")).toBe(false);
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).not.toBe("cancelled");

  expect((await f.wait()).status).toBe("settled");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 20_000 }).toBe(3);
  const parked = f.evidence().filter((turn: any) => turn.botId === f.chief.id)[2];
  expect(parked.resumed).toBe(false);
  expect(told(parked)).not.toContain("Assignments you already sent are still outstanding");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Also make sure the export is UTF-8.")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Noted; the export is UTF-8 too")).toBe(true);
}), 60_000);

it("does not cancel a live coordination when an automation turn lands in the conversation", () => fixture(async f => {
  const ops = (await f.cli("new-bot", "--name", "Ops", "--section", "Leadership")).bot;
  f.plan[f.lead.id] = { delayMs: 6000, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "The requested CSV export is implemented and verified" },
    { reply: "Nothing further" },
  ] };
  f.plan[ops.id] = { turns: [
    { steps: [{ tool: "delegate_bot", arguments: { bot_id: f.chief.id, message: "Nightly note: confirm the export owner." } }], reply: "Delegated the nightly note" },
    { reply: "Recorded the outcome of the nightly note" },
  ] };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  const { routine } = await f.api("/api/routines", { name: "Nightly note", prompt: "Send the nightly note.", botId: ops.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  await f.api(`/api/routines/${routine.id}/run`, {});
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.peerAsk?.botId === ops.id), { timeout: 25_000 }).toBe(true);
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).not.toBe("cancelled");

  await expect.poll(() => f.nodes().find((node: any) => node.id === assignment.id)?.status, { timeout: 25_000 }).toBe("completed");
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied"), { timeout: 15_000 }).toBe(true);
}), 60_000);

it("stops a waiting source without reaching into the teammate already working", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 4000, reply: "Finished after the source was stopped" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.chief.activeTaskId });

  await expect.poll(() => f.nodes().find((node: any) => !node.parentId)?.status).toBe("cancelled");
  expect(f.nodes().find((node: any) => node.parentId).status).toBe("running");
  expect((await f.wait()).status).toBe("settled");
  const chip = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.tool?.name?.startsWith("Stopped here"));
  expect(chip.tool.name).toContain("Engineering lead");
  expect(chip.threadRef).toMatchObject({ botId: f.lead.id, threadId: f.nodes().find((node: any) => node.parentId).threadId });

  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 20_000 }).toBe("completed");
  expect(f.nodes().find((node: any) => node.parentId).result).toContain("Finished after the source was stopped");
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied")).toBe(true);
  const replied = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.tool?.name === "Engineering lead replied");
  expect(replied.tool.output).toContain("Finished after the source was stopped");
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
}), 60_000);

it("deleting the waiting source cancels its tree and never recreates the deleted conversation", () => fixture(async f => {
  const childGate = join(f.session.info.dataDir, "child-ready");
  f.plan[f.lead.id] = { gateFile: childGate, reply: "Must not return to a deleted task" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await expect.poll(async () => {
    const waiting = (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.chief.id);
    return !waiting.busy && waiting.tasks.find((task: any) => task.threadId === f.chief.activeTaskId)?.waitingForTeammates;
  }, { timeout: 30_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.chief.activeTaskId}`, {}, "DELETE");
  await expect.poll(() => f.nodes().every((node: any) => node.status === "cancelled")).toBe(true);
  writeFileSync(childGate, "finish after the source was deleted");
  await expect.poll(async () => (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.lead.id).busy, { timeout: 15_000 }).toBe(false);
  expect(f.nodes().every((node: any) => node.status === "cancelled")).toBe(true);
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  expect(chief.tasks.some((task: any) => task.threadId === f.chief.activeTaskId)).toBe(false);
  expect(await f.messages(chief.threadId)).toEqual([]);
  for (const task of chief.tasks) {
    expect((await f.messages(task.threadId)).some((message: any) => message.text?.includes("Must not return to a deleted task"))).toBe(false);
  }
}), 45_000);

it("withholds direct results when the owner revokes explicit peer access", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 3000, reply: "PRIVATE_ENGINEERING_RESULT" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}`, { peers: [] }, "PATCH");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((node: any) => node.parentId).status).toBe("failed");
  const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
  expect(resumed.prompt.message.content).toContain("Result withheld");
  expect(JSON.stringify(resumed)).not.toContain("PRIVATE_ENGINEERING_RESULT");
}), 45_000);

it("retains returned direct reports for follow-up turns but rechecks access before replay", () => fixture(async f => {
  f.plan[f.lead.id] = { reply: "PRIVATE_ENGINEERING_FACT_8347" };
  f.plan[f.chief.id].resumeReply = "Finished";
  await f.start(); expect((await f.wait()).status).toBe("settled");
  f.plan[f.chief.id] = { reply: "Follow-up answered" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Summarize the existing engineering report");
  expect((await f.wait()).status).toBe("settled");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Follow-up answered")).toBe(true);
  const followup = (await f.messages(f.chief.activeTaskId)).findLast((message: any) => message.role === "user");
  f.plan[f.chief.id].expectContextIncludes = ["PRIVATE_ENGINEERING_FACT_8347"];
  f.save();
  await f.api(`/api/bots/${f.chief.id}/messages/${followup.id}/edit`, { threadId: f.chief.activeTaskId, text: "Check the earlier engineering report" });
  expect((await f.wait()).status).toBe("settled");
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1).prompt.message.content).toContain("PRIVATE_ENGINEERING_FACT_8347");
  await f.api(`/api/bots/${f.chief.id}`, { peers: [] }, "PATCH");
  f.plan[f.chief.id] = { reply: "Access removed", expectContextIncludes: ["Teammate result withheld"] };
  f.save();
  const edited = (await f.messages(f.chief.activeTaskId)).findLast((message: any) => message.role === "user");
  await f.api(`/api/bots/${f.chief.id}/messages/${edited.id}/edit`, { threadId: f.chief.activeTaskId, text: "What can you access now?" });
  expect((await f.wait()).status).toBe("settled");
  const final = f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1);
  expect(final.prompt.message.content).toContain("Teammate result withheld");
  expect(JSON.stringify({ system: final.system, prompt: final.prompt })).not.toContain("PRIVATE_ENGINEERING_FACT_8347");
}), 45_000);

it("sends each teammate result once in the turn that reviews it", () => fixture(async f => {
  f.plan[f.lead.id].resumeReply = "LEAD_RESULT_ONCE implemented and verified";
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const text = String(f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1).prompt.message.content);
  expect(text).toContain("Your downstream room requests have settled.");
  expect(text.split("LEAD_RESULT_ONCE").length - 1).toBe(1);
}), 45_000);

it("gives a teammate each request once, never also as a bare assistant line", () => fixture(async f => {
  f.plan[f.lead.id] = { reply: "round result" };
  for (const key of ["first", "second"]) {
    f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: `REQUEST_${key.toUpperCase()} please do it` } }], reply: "Assigned", resumeReply: "Done" };
    f.save();
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", `Delegate the ${key} request.`);
    expect((await f.wait()).status).toBe("settled");
  }
  const second = String(f.evidence().filter((turn: any) => turn.botId === f.lead.id).at(-1).prompt.message.content);
  expect(second.split("REQUEST_SECOND").length - 1).toBe(1);
  expect(second).not.toMatch(/^Assistant: @/m);
}, { FAKE_CLAUDE_MODE: "dead-session" }), 60_000);
