import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { request } from "../scripts/mcp-server.ts";
import { openSse } from "./testing/sse.ts";

async function withFixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string) => request(path, {}, session.info.url) as Promise<any>;
  const stream = await openSse(session.info.url + "/api/events");
  const planPath = join(session.info.dataDir, "room-plan.json");
  try {
    await test({
      cli,
      frames: stream.frames,
      savePlan: (plan: Record<string, unknown>) => writeFileSync(planPath, JSON.stringify(plan)),
      evidence: () => existsSync(planPath + ".evidence.jsonl")
        ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
      messages: async (threadId: string) => (await api("/api/threads/" + threadId + "/messages")).messages,
      turn: async (bot: any, text: string) => {
        await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
        expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
      },
    });
  } finally {
    stream.close();
    await session.close();
  }
}

it("puts a dog's tapback on the person's message and posts no bubble for a turn that only reacts", async () => withFixture(async (f) => {
  const bot = (await f.cli("new-bot", "--name", "Tapback dog")).bot;
  f.savePlan({ [bot.id]: { steps: [{ tool: "react", arguments: { emoji: "👍" } }], reply: "👍" } });
  await f.turn(bot, "ok");

  const turn = f.evidence().find((entry: any) => entry.botId === bot.id);
  expect(turn.evidence[0].result.tools.map((tool: any) => tool.name)).toContain("react");
  const step = turn.evidence.find((entry: any) => entry.step);
  expect(step.response.result.isError).toBeFalsy();
  expect(step.response.result.content[0].text).toContain("Reacted 👍 to “ok”");

  const messages = await f.messages(bot.activeTaskId);
  const asked = messages.find((m: any) => m.role === "user" && m.text?.startsWith("ok"));
  expect(asked.reactions).toEqual([{ emoji: "👍", by: bot.id }]);
  const answers = (list: any[]) => list.slice(list.findIndex((m: any) => m.id === asked.id)).filter((m: any) => m.role === "bot" && m.kind === "text").map((m: any) => m.text);
  expect(answers(messages)).toEqual([]);
  expect(f.frames.some((frame: any) => frame.kind === "message.patch" && frame.message?.id === asked.id && frame.message?.reactions?.[0]?.emoji === "👍")).toBe(true);
  expect(f.frames.filter((frame: any) => frame.kind === "notify" && frame.notification?.threadId === bot.activeTaskId)).toEqual([]);
  expect(f.frames.filter((frame: any) => frame.kind === "runtime" && frame.event?.threadId === bot.activeTaskId && frame.event?.itemType === "assistant_text")).toEqual([]);

  f.savePlan({ [bot.id]: { steps: [{ tool: "react", arguments: { emoji: "❤️", message_id: asked.id } }], reply: "Glad it landed." } });
  await f.turn(bot, "thanks, that fixed it");
  const after = await f.messages(bot.activeTaskId);
  expect(after.find((m: any) => m.id === asked.id).reactions).toEqual([{ emoji: "❤️", by: bot.id }]);
  expect(answers(after)).toEqual(["Glad it landed."]);
}), 60_000);

it("turns a reply that is only a written-out reaction into a tapback, with no bubble and no raw text streamed", async () => withFixture(async (f) => {
  const bot = (await f.cli("new-bot", "--name", "Plain reply dog")).bot;
  f.savePlan({ [bot.id]: { steps: [], reply: "<agents_react>\n{\"emoji\": \"👍\"}\n</agents_react>" } });
  await f.turn(bot, "thanks");

  const messages = await f.messages(bot.activeTaskId);
  const asked = messages.find((m: any) => m.role === "user" && m.text?.startsWith("thanks"));
  expect(asked.reactions).toEqual([{ emoji: "👍", by: bot.id }]);
  expect(messages.slice(messages.indexOf(asked)).filter((m: any) => m.role === "bot" && m.kind === "text")).toEqual([]);
  expect(f.frames.some((frame: any) => frame.kind === "message.patch" && frame.message?.id === asked.id && frame.message?.reactions?.[0]?.emoji === "👍")).toBe(true);
  expect(JSON.stringify(f.frames.filter((frame: any) => frame.kind === "runtime" && frame.event?.threadId === bot.activeTaskId))).not.toContain("agents_react");

  f.savePlan({ [bot.id]: { steps: [], reply: "Glad it worked 👍" } });
  await f.turn(bot, "ok");
  const after = await f.messages(bot.activeTaskId);
  const okAt = after.findIndex((m: any) => m.role === "user" && m.text?.startsWith("ok"));
  expect(after.slice(okAt).filter((m: any) => m.role === "bot" && m.kind === "text").map((m: any) => m.text)).toEqual(["Glad it worked 👍"]);
  expect(after[okAt].reactions).toBeUndefined();
}), 60_000);

it("refuses a tapback that is not one emoji, or that names no message in the chat", async () => withFixture(async (f) => {
  const bot = (await f.cli("new-bot", "--name", "Picky dog")).bot;
  f.savePlan({
    [bot.id]: {
      steps: [
        { tool: "react", arguments: { emoji: "ok" }, expectError: true },
        { tool: "react", arguments: { emoji: "👍", message_id: "not-here" }, expectError: true },
      ],
      reply: "Noted.",
    },
  });
  await f.turn(bot, "ok");
  const steps = f.evidence().find((entry: any) => entry.botId === bot.id).evidence.filter((entry: any) => entry.step);
  expect(steps.map((entry: any) => entry.response.result.content[0].text)).toEqual([
    "react needs one emoji, for example 👍.",
    "No message with that id in this chat.",
  ]);
  const messages = await f.messages(bot.activeTaskId);
  expect(messages.find((m: any) => m.role === "user").reactions).toBeUndefined();
}), 60_000);
