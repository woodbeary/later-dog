import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../scripts/control-laterdog.ts";
import { request } from "../scripts/mcp-server.ts";
import { openSse } from "./testing/sse.ts";
import { waitForExit } from "./testing/cleanup.ts";

const item = (text: string, status: string) => ({ text, status });

it("keeps a dog's plan per chat, on the wire, across a restart, and out of a helper's reach", async () => {
  const env = { ...process.env, FAKE_CLAUDE_VERSION: "2.1.316" };
  const session = await launchVerificationServer(env, undefined, undefined, undefined, undefined, { scripted: true });
  let restarted: ChildProcess | undefined;
  const stream = await openSse(session.info.url + "/api/events");
  try {
    const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
    const api = (path: string) => request(path, {}, session.info.url) as Promise<any>;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const evidence = () => existsSync(planPath + ".evidence.jsonl")
      ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const turn = async (bot: any, text: string) => {
      await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    };
    const wirePlan = async (bot: any) => {
      const wire = (await api("/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id);
      return wire.tasks.find((task: any) => task.threadId === bot.activeTaskId)?.plan;
    };
    const stepResults = (botId: string) => evidence().filter((entry: any) => entry.botId === botId).flatMap((entry: any) => entry.evidence.filter((row: any) => row.step).map((row: any) => row.response.result.content[0].text));

    const dog = (await cli("new-bot", "--name", "Plan dog")).bot;
    const other = (await cli("new-bot", "--name", "Other dog")).bot;
    const first = [item("Fix the login", "in_progress"), item("Write the release note", "pending")];
    const second = [item("Fix the login", "done"), item("Write the release note", "in_progress")];
    writeFileSync(planPath, JSON.stringify({
      [dog.id]: { turns: [
        { steps: [{ tool: "set_plan", toolUseId: "toolu_dog_1", arguments: { items: first } }], reply: "On it." },
        { steps: [
          { tool: "set_plan", toolUseId: "toolu_helper_1", parentToolUseId: "toolu_task_1", arguments: { items: [item("Helper's own step", "in_progress")] } },
          { tool: "set_plan", toolUseId: "toolu_dog_2", arguments: { items: second } },
        ], reply: "Login fixed." },
      ] },
      [other.id]: { steps: [{ tool: "set_plan", arguments: { items: [item("Other dog's work", "pending")] } }], reply: "Noted." },
    }));

    const tools = evidence;
    await turn(dog, "Fix the login, and later write the release note");
    expect(tools().find((entry: any) => entry.botId === dog.id).evidence[0].result.tools.map((tool: any) => tool.name)).toContain("set_plan");
    const loaded = tools().find((entry: any) => entry.botId === dog.id).evidence[0].result.tools.find((tool: any) => tool.name === "set_plan");
    expect(loaded._meta?.["anthropic/alwaysLoad"]).not.toBe(false);
    expect(stepResults(dog.id)).toEqual(["Plan recorded: 0 of 2 done, now “Fix the login”, 1 not started. The person sees it in the app."]);
    expect((await wirePlan(dog)).items).toEqual(first);
    expect(stream.frames.some((frame: any) => frame.kind === "bot" && frame.bot?.id === dog.id && frame.bot.tasks?.some((task: any) => task.plan?.items?.[0]?.status === "in_progress"))).toBe(true);

    await waitForExit(session.child, { signal: "SIGTERM" });
    const log = openSync(session.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: process.cwd(), env: verificationServerEnvironment(env, session.info.dataDir, Number(new URL(session.info.url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    expect((await wirePlan(dog)).items).toEqual(first);

    await turn(dog, "thanks, carry on");
    expect(stepResults(dog.id).slice(1)).toEqual([
      "Not recorded: the plan belongs to the dog that talks to the person. Report your progress in your last message instead.",
      "Plan recorded: 1 of 2 done, now “Write the release note”. The person sees it in the app.",
    ]);
    expect((await wirePlan(dog)).items).toEqual(second);

    await turn(other, "Note this for later");
    expect((await wirePlan(other)).items).toEqual([item("Other dog's work", "pending")]);
    expect((await wirePlan(dog)).items).toEqual(second);
    const stored = JSON.parse(readFileSync(join(session.info.dataDir, "dog-plans.json"), "utf8"));
    expect(stored.map((row: any) => row.threadId).sort()).toEqual([dog.activeTaskId, other.activeTaskId].sort());
    writeFileSync(`${session.info.logPath}.plan.json`, JSON.stringify({ stored, turns: evidence() }, null, 2), { mode: 0o600 });
    console.info(`Plan evidence: ${session.info.logPath}.plan.json`);
  } finally {
    stream.close();
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await session.close();
  }
}, 120_000);
