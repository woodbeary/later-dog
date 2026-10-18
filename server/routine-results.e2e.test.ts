import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";

it("runs every routine in the dog's one conversation, waits behind the person's turn and keeps approvals there", async () => {
  const fixture = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let broker: Socket | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const control = (args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]);
  const runState = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=200`)).messages as any[];
  try {
    expect((await control(["doctor"]) as any).ok).toBe(true);
    const { bot } = await control(["new-bot", "--name", "Results fixture"]) as any;
    const currentBot = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    const mainThread = (await currentBot()).threadId as string;
    const { routine } = await api("POST", "/api/routines", {
      name: "Persistent report", prompt: "Report this run's state.", botId: bot.id, enabled: false, resultsThreadId: "ignored",
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    expect(routine).not.toHaveProperty("resultsThreadId");
    const completed: any[] = [];
    for (let index = 0; index < 2; index++) {
      const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
      expect(run).not.toHaveProperty("resultsThreadId");
      await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
      completed.push(await runState(run.id));
      evidence.push(await control(["wait", "--bot", bot.id, "--task", mainThread]));
    }
    for (const run of completed) expect(run.threadId).toBe(mainThread);
    const main = await messages(mainThread);
    const cards = main.filter((message) => message.kind === "routine.run");
    expect(cards).toHaveLength(2);
    for (const run of completed) {
      const card = cards.find((message) => message.routineRun.runId === run.id)?.routineRun;
      expect(card).toMatchObject({ status: "completed", scheduledFor: run.scheduledFor });
      expect(card).not.toHaveProperty("executionThreadId");
      expect(card).not.toHaveProperty("summary");
    }
    for (const card of cards) expect(card.text).toBe("Routine “Persistent report” completed");
    expect(main.filter((message) => message.role === "user" && message.text?.includes("Report this run's state."))).toHaveLength(2);
    expect(main.filter((message) => message.role === "bot" && message.kind === "text" && message.text === "hello from fake claude").length).toBeGreaterThanOrEqual(2);
    const savedBot = await currentBot();
    expect(savedBot.threadId).toBe(mainThread);
    expect(savedBot.tasks).toHaveLength(1);
    expect(savedBot.tasks[0]).toMatchObject({ threadId: mainThread, unread: true });
    expect(savedBot.tasks[0].title).not.toContain("Report this run's state.");
    expect(savedBot.tasks[0].routineRunId).toBeUndefined();
    expect((await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: "ignored-again" })).routine).not.toHaveProperty("resultsThreadId");

    const gate = join(fixture.info.dataDir, "results-finish");
    const wrapper = join(fixture.info.dataDir, "results-slow.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(gate)};`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: mainThread, text: "Tell me something first." }, 202);
    await expect.poll(async () => (await currentBot()).busy, { timeout: 15_000 }).toBe(true);
    const { run: deferred } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await runState(deferred.id))?.deferredAt, { timeout: 15_000 }).toEqual(expect.any(Number));
    expect((await runState(deferred.id)).status).toBe("queued");
    expect((await messages(mainThread)).find((message) => message.routineRun?.runId === deferred.id)?.text)
      .toBe("Routine “Persistent report” deferred: target busy");
    writeFileSync(gate, "finish the person's turn");
    await expect.poll(async () => (await runState(deferred.id))?.status, { timeout: 30_000 }).toBe("completed");
    expect((await runState(deferred.id)).threadId).toBe(mainThread);
    const afterDeferral = await messages(mainThread);
    const personReply = afterDeferral.findIndex((message) => message.role === "bot" && message.text === "reply to: Tell me something first.");
    const deferredPrompt = afterDeferral.findLastIndex((message) => message.role === "user" && message.text?.includes("Report this run's state."));
    expect(personReply).toBeGreaterThan(-1);
    expect(deferredPrompt).toBeGreaterThan(personReply);

    rmSync(gate, { force: true });
    const { run: pending } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("running");
    expect((await runState(pending.id)).threadId).toBe(mainThread);
    await expect.poll(() => {
      if (!existsSync(fixture.fixtureDumpPath)) return false;
      return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.agents?.env?.LATERDOG_THREAD_ID === mainThread;
    }, { timeout: 15_000 }).toBe(true);
    const launched = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const socketPath = launched.mcpConfig.mcpServers.dog.args.at(-1);
    broker = connect(socketPath);
    broker.on("error", () => {});
    await new Promise<void>((resolve, reject) => { broker!.once("connect", resolve); broker!.once("error", reject); });
    broker.write(JSON.stringify({ t: "ask", id: "results-approval", kind: "permission", tool: "Bash", input: { command: "echo fixture-approval" } }) + "\n");
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("waiting");
    const waitingCard = (await messages(mainThread)).find((message) => message.routineRun?.runId === pending.id);
    expect(waitingCard.routineRun).toMatchObject({ status: "waiting" });
    const approval = (await messages(mainThread)).find((message) => message.card && !message.card.answered);
    expect(approval?.card.tool).toBe("Bash");
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: mainThread, requestId: approval.card.requestId, behavior: "deny" });
    writeFileSync(gate, "complete the isolated turn");
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("completed");
    const final = await currentBot();
    expect(final.tasks).toHaveLength(1);
    expect((await messages(mainThread)).filter((message) => message.kind === "routine.run")).toHaveLength(4);
    evidence.push({ final: await api("GET", "/api/routines"), bot: final, main: await messages(mainThread) });
  } finally {
    broker?.destroy();
    const evidencePath = `${fixture.info.logPath}.results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 120_000);

it("runs a routine made in another chat in the dog's one conversation, not that chat or a new thread", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]) as Promise<any>;
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  try {
    const { bot } = await cli("new-bot", "--name", "Chat routine fixture");
    const mainThread = bot.activeTaskId as string;
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Planning" }, 201);
    const chat = task.threadId as string;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "propose_routine", arguments: {
        name: "Chat report", instructions: "Report the fixture state; no external services.",
        schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "UTC" },
      } }], reply: "The routine is scheduled." },
      { steps: [], reply: "Fresh chat report" },
    ] } }));
    await cli("send", "--bot", bot.id, "--task", chat, "--text", "Report the fixture state monthly.");
    await cli("wait", "--bot", bot.id, "--task", chat, "--timeout", "20");
    const card = (await messages(chat)).findLast((message) => message.card?.routineRequest)?.card;
    expect(card).toMatchObject({ answered: "allow", autoApplied: true });
    const routineId = card.routineRequest.resultId as string;
    const definition = (await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === routineId);
    expect(definition.sourceThreadId).toBe(chat);
    await api("POST", `/api/bots/${bot.id}/tasks/${mainThread}`, {});

    const { run } = await api("POST", `/api/routines/${routineId}/run`, undefined, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id)?.status, { timeout: 20_000 }).toBe("completed");
    const finished = (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
    expect(finished.threadId).toBe(mainThread);
    const runCard = (await messages(mainThread)).find((message) => message.routineRun?.runId === run.id)?.routineRun;
    expect(runCard).toMatchObject({ status: "completed" });
    expect(runCard).not.toHaveProperty("executionThreadId");
    expect((await messages(mainThread)).some((message) => message.role === "bot" && message.text === "Fresh chat report")).toBe(true);
    expect((await messages(chat)).some((message) => message.kind === "routine.run")).toBe(false);
    const saved = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    expect(saved.tasks.map((candidate: any) => candidate.threadId).sort()).toEqual([mainThread, chat].sort());
    expect(saved.tasks.find((candidate: any) => candidate.threadId === mainThread).unread).toBe(true);
    const mainBefore = await messages(mainThread);
    await api("DELETE", `/api/bots/${bot.id}/tasks/${chat}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await messages(mainThread)).toEqual(mainBefore);
    evidence.push({ run: finished, bot: saved, main: await messages(mainThread) });
  } finally {
    const evidencePath = `${fixture.info.logPath}.chat-results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);

it("lets only a routine's own turns move its run while the person chats, delegates and fails a reply in the same conversation", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]) as Promise<any>;
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=200`)).messages as any[];
  const turns = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  try {
    const ops = (await cli("new-bot", "--name", "Ops", "--section", "Operations")).bot;
    const lead = (await cli("new-bot", "--name", "Lead", "--section", "Operations")).bot;
    const helper = (await cli("new-bot", "--name", "Helper", "--section", "Operations")).bot;
    const main = ops.activeTaskId as string;
    const leadGate = join(fixture.info.dataDir, "lead-report.gate");
    writeFileSync(planPath, JSON.stringify({
      [ops.id]: { turns: [
        { steps: [{ tool: "delegate_bot", arguments: { bot_id: lead.id, message: "Write the weekly report." } }], reply: "ROUTINE asked Lead" },
        { steps: [{ arguments: { bot_ids: [helper.id], message: "Check the invoice total." } }], reply: "PERSON asked Helper" },
        { reply: "PERSON got Helper's answer" },
        { fail: true },
        { reply: "ROUTINE has Lead's report" },
      ] },
      [helper.id]: { turns: [{ reply: "The invoice total is 42" }] },
    }));
    writeFileSync(`${planPath}.gates.json`, JSON.stringify([{ promptIncludes: "Write the weekly report.", gateFile: leadGate }]));
    const { routine } = await api("POST", "/api/routines", {
      name: "Weekly report", prompt: "Get the weekly report from Lead.", botId: ops.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const runState = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.routineId === routine.id);
    await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await runState())?.status, { timeout: 20_000 }).toBe("waiting");
    expect(await runState()).toMatchObject({ threadId: main, output: "ROUTINE asked Lead" });

    await cli("send", "--bot", ops.id, "--task", main, "--text", "Ask Helper to check the invoice total.");
    await expect.poll(async () => (await messages(main)).some((message) => message.text === "PERSON got Helper's answer"), { timeout: 25_000 }).toBe(true);
    expect(await runState()).toMatchObject({ status: "waiting", output: "ROUTINE asked Lead" });

    await cli("send", "--bot", ops.id, "--task", main, "--text", "Try the step that fails.");
    await expect.poll(() => turns().filter((turn) => turn.botId === ops.id).length, { timeout: 20_000 }).toBe(4);
    await cli("wait", "--bot", ops.id, "--task", main, "--timeout", "20");
    expect(await runState()).toMatchObject({ status: "waiting", output: "ROUTINE asked Lead" });

    writeFileSync(leadGate, "release the isolated teammate");
    await expect.poll(async () => (await runState())?.status, { timeout: 30_000 }).toBe("completed");
    expect((await runState()).output).toBe("ROUTINE has Lead's report");
    const opsTurns = turns().filter((turn) => turn.botId === ops.id);
    expect(opsTurns).toHaveLength(5);
    expect(opsTurns.every((turn) => turn.threadId === main)).toBe(true);
    const saved = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === ops.id);
    expect(saved.tasks).toHaveLength(1);
    evidence.push({ run: await runState(), main: await messages(main), turns: turns().map(({ botId, turnIndex, threadId }) => ({ botId, turnIndex, threadId })) });
  } finally {
    const bots = await fetch(`${fixture.info.url}/api/bots`).then((response) => response.json()).catch(() => null) as any;
    for (const bot of bots?.bots ?? []) evidence.push({ bot: bot.name, lines: await messages(bot.threadId).catch(() => []) });
    evidence.push({ turns: turns().map(({ botId, turnIndex, threadId, prompt }) => ({ botId, turnIndex, threadId, prompt })) });
    const evidencePath = `${fixture.info.logPath}.shared-conversation.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 120_000);

it("cancels a waiting routine without touching the person's reply or their teammate's answer in the same conversation", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]) as Promise<any>;
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=200`)).messages as any[];
  const turns = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  try {
    const ops = (await cli("new-bot", "--name", "Ops", "--section", "Operations")).bot;
    const lead = (await cli("new-bot", "--name", "Lead", "--section", "Operations")).bot;
    const helper = (await cli("new-bot", "--name", "Helper", "--section", "Operations")).bot;
    const main = ops.activeTaskId as string;
    const leadGate = join(fixture.info.dataDir, "lead-report.gate");
    const helperGate = join(fixture.info.dataDir, "helper-answer.gate");
    const personGate = join(fixture.info.dataDir, "person-reply.gate");
    const personReady = join(fixture.info.dataDir, "person-reply.ready");
    writeFileSync(planPath, JSON.stringify({
      [ops.id]: { turns: [
        { steps: [{ tool: "delegate_bot", arguments: { bot_id: lead.id, message: "Write the weekly report." } }], reply: "ROUTINE asked Lead" },
        { steps: [{ arguments: { bot_ids: [helper.id], message: "Check the invoice total." } }], reply: "PERSON asked Helper" },
        { reply: "PERSON held reply", readyFile: personReady, gateFile: personGate },
        { reply: "PERSON got Helper's answer" },
      ] },
      [helper.id]: { turns: [{ reply: "The invoice total is 42", gateFile: helperGate }] },
    }));
    writeFileSync(`${planPath}.gates.json`, JSON.stringify([
      { promptIncludes: "Write the weekly report.", gateFile: leadGate },
      { promptIncludes: "Check the invoice total.", gateFile: helperGate },
    ]));
    const { routine } = await api("POST", "/api/routines", {
      name: "Weekly report", prompt: "Get the weekly report from Lead.", botId: ops.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const runState = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.routineId === routine.id);
    await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await runState())?.status, { timeout: 20_000 }).toBe("waiting");
    const run = await runState();
    expect(run).toMatchObject({ threadId: main, output: "ROUTINE asked Lead" });

    await cli("send", "--bot", ops.id, "--task", main, "--text", "Ask Helper to check the invoice total.");
    await expect.poll(async () => (await messages(main)).some((message) => message.text === "PERSON asked Helper"), { timeout: 20_000 }).toBe(true);
    await cli("wait", "--bot", ops.id, "--task", main, "--timeout", "20");

    await cli("send", "--bot", ops.id, "--task", main, "--text", "Hold this reply for a moment.");
    await expect.poll(() => existsSync(personReady), { timeout: 20_000 }).toBe(true);
    writeFileSync(helperGate, "let Helper answer while the person's reply is still going");
    await expect.poll(() => turns().some((turn) => turn.botId === helper.id), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await messages(main)).some((message) => message.tool?.name === "Helper replied"), { timeout: 20_000 }).toBe(true);
    expect((await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === ops.id).busy).toBe(true);

    const cancelled = await api("POST", `/api/routine-runs/${run.id}/cancel`);
    expect(cancelled.run).toMatchObject({ id: run.id, status: "cancelled" });
    expect((await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === ops.id).busy).toBe(true);
    writeFileSync(personGate, "finish the person's reply");
    await expect.poll(async () => (await messages(main)).some((message) => message.text === "PERSON held reply"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await messages(main)).some((message) => message.text === "PERSON got Helper's answer"), { timeout: 25_000 }).toBe(true);
    await cli("wait", "--bot", ops.id, "--task", main, "--timeout", "20");

    writeFileSync(leadGate, "release the isolated teammate after the run was cancelled");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await cli("wait", "--bot", ops.id, "--task", main, "--timeout", "20");
    expect(await runState()).toMatchObject({ id: run.id, status: "cancelled", output: "ROUTINE asked Lead" });
    const opsTurns = turns().filter((turn) => turn.botId === ops.id);
    expect(opsTurns).toHaveLength(4);
    expect(opsTurns.every((turn) => turn.threadId === main)).toBe(true);
    const lines = await messages(main);
    expect(lines.some((message) => message.role === "bot" && /interrupted|stopped/i.test(message.tool?.name ?? "") && message.at > run.startedAt)).toBe(false);
    expect(lines.some((message) => /queued delegation.* dropped/.test(message.tool?.name ?? ""))).toBe(false);
    evidence.push({ run: await runState(), main: lines, turns: turns().map(({ botId, turnIndex, threadId }) => ({ botId, turnIndex, threadId })) });
  } finally {
    const bots = await fetch(`${fixture.info.url}/api/bots`).then((response) => response.json()).catch(() => null) as any;
    for (const bot of bots?.bots ?? []) evidence.push({ bot: bot.name, lines: await messages(bot.threadId).catch(() => []) });
    evidence.push({ turns: turns().map(({ botId, turnIndex, threadId, prompt }) => ({ botId, turnIndex, threadId, prompt })) });
    const evidencePath = `${fixture.info.logPath}.cancel-during-person.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 150_000);
