import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";
import { request } from "../../scripts/mcp-server.ts";
import { openSse } from "../testing/sse.ts";

const unfinished = [{ text: "Repair and check the saved output", status: "in_progress" }];
const finished = [{ ...unfinished[0], status: "done" }];
const planStep = (items: typeof unfinished) => ({ tool: "set_plan", arguments: { items } });

async function fixture(run: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.316" }, undefined, undefined, undefined, undefined, { scripted: true });
  const stream = await openSse(`${session.info.url}/api/events`);
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const planPath = join(session.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  try { await run({ session, stream, cli, api, planPath, evidence }); }
  catch (error) {
    const saved = join(session.info.dataDir, "plan-continuations.json");
    writeFileSync(`${session.info.logPath}.continuation.json`, JSON.stringify({
      queue: existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : null,
      evidence: evidence(), bots: await api("/api/bots?messages=20"),
      frames: stream.frames.slice(-30),
    }, null, 2));
    console.info(`Continuation evidence: ${session.info.logPath}.continuation.json`);
    throw error;
  }
  finally { stream.close(); await session.close(); }
}

it.each(["max_turns", "context_length_exceeded", "tool_call_limit"])("continues a %s ending in the same chat and keeps the plan working", reason => fixture(async f => {
  const dog = (await f.cli("new-bot", "--name", "Repair dog")).bot;
  writeFileSync(f.planPath, JSON.stringify({ [dog.id]: { turns: [
    { steps: [planStep(unfinished)], reply: "Checkpoint saved.", stopReason: reason, isError: true },
    { expectContextIncludes: ["later.dog continuation"], steps: [planStep(finished)], reply: "Saved output checked." },
  ] } }));
  await f.cli("send", "--bot", dog.id, "--task", dog.activeTaskId, "--text", "Repair the output and verify it.");
  await expect.poll(() => f.evidence().filter((row: any) => row.botId === dog.id).length, { timeout: 30_000 }).toBe(2);
  expect((await f.cli("wait", "--bot", dog.id, "--task", dog.activeTaskId, "--timeout", "20")).status).toBe("settled");
  const wire = (await f.api("/api/bots?messages=0")).bots.find((row: any) => row.id === dog.id);
  expect(wire.tasks).toHaveLength(1);
  expect(wire.tasks[0].plan.items).toEqual(finished);
  const rows = (await f.api(`/api/threads/${dog.activeTaskId}/messages?limit=100`)).messages;
  expect(rows.filter((row: any) => row.role === "user")).toHaveLength(1);
  const frames = f.stream.frames.filter((frame: any) => frame.kind === "bot" && frame.bot?.id === dog.id);
  const incomplete = frames.filter((frame: any) => frame.bot.tasks?.some((task: any) => task.plan?.items?.[0]?.status === "in_progress"));
  expect(incomplete.length).toBeGreaterThan(0);
  expect(incomplete.every((frame: any) => frame.bot.tasks.find((task: any) => task.threadId === dog.activeTaskId).work.kind === "running")).toBe(true);
}), 70_000);

it("returns a delegated result only after its limited helper finishes the saved plan", () => fixture(async f => {
  const lead = (await f.cli("new-bot", "--name", "Lead")).bot;
  const helper = (await f.cli("new-bot", "--name", "Repair helper")).bot;
  writeFileSync(f.planPath, JSON.stringify({
    [lead.id]: { steps: [{ arguments: { bot_ids: [helper.id], message: "Repair the output and check it." } }], reply: "Assigned.", resumeReply: "Repair verified with the helper result." },
    [helper.id]: { turns: [
      { steps: [planStep(unfinished)], reply: "Checkpoint saved.", stopReason: "max_tokens", isError: true },
      { steps: [planStep(finished)], reply: "Repair is verified." },
    ] },
  }));
  await f.cli("send", "--bot", lead.id, "--task", lead.activeTaskId, "--text", "Ask the helper to repair and check the output.");
  await expect.poll(() => f.evidence().filter((row: any) => row.botId === helper.id).length, { timeout: 30_000 }).toBe(2);
  expect((await f.cli("wait", "--bot", lead.id, "--task", lead.activeTaskId, "--timeout", "30")).status).toBe("settled");
  const resumed = f.evidence().find((row: any) => row.botId === lead.id && row.resumed);
  expect(JSON.stringify(resumed)).toContain("Repair is verified.");
}), 80_000);

it.each(["end_turn", "interrupted", "usage_limit"])("does not turn %s into plan continuation", reason => fixture(async f => {
  const dog = (await f.cli("new-bot", "--name", "Stopped dog")).bot;
  writeFileSync(f.planPath, JSON.stringify({ [dog.id]: { turns: [{ steps: [planStep(unfinished)], reply: "Saved the current state.", stopReason: reason, isError: reason !== "end_turn" }] } }));
  await f.cli("send", "--bot", dog.id, "--task", dog.activeTaskId, "--text", "Check the output.");
  await expect.poll(() => f.evidence().filter((row: any) => row.botId === dog.id).length, { timeout: 20_000 }).toBe(1);
  expect((await f.cli("wait", "--bot", dog.id, "--task", dog.activeTaskId, "--timeout", "20")).status).toBe("settled");
  const ledger = join(f.session.info.dataDir, "plan-continuations.json");
  expect(existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")).some((row: any) => row.pending) : false).toBe(false);
}), 60_000);

it("stops repeated limits without progress and retains the unfinished plan", () => fixture(async f => {
  const dog = (await f.cli("new-bot", "--name", "Bounded dog")).bot;
  writeFileSync(f.planPath, JSON.stringify({ [dog.id]: { turns: Array.from({ length: 4 }, () => ({
    steps: [planStep(unfinished)], reply: "Checkpoint saved without another completed step.", stopReason: "max_turns", isError: true,
  })) } }));
  await f.cli("send", "--bot", dog.id, "--task", dog.activeTaskId, "--text", "Repair the output.");
  await expect.poll(() => f.evidence().filter((row: any) => row.botId === dog.id).length, { timeout: 30_000 }).toBe(4);
  expect((await f.cli("wait", "--bot", dog.id, "--task", dog.activeTaskId, "--timeout", "20")).status).toBe("settled");
  const rows = (await f.api(`/api/threads/${dog.activeTaskId}/messages?limit=100`)).messages;
  expect(rows.some((row: any) => row.tool?.name.includes("3 continuation turns finished without completing another plan step"))).toBe(true);
  const wire = (await f.api("/api/bots?messages=0")).bots.find((row: any) => row.id === dog.id);
  expect(wire.tasks[0].plan.items).toEqual(unfinished);
  expect(wire.tasks[0].busy).toBe(false);
}), 70_000);
