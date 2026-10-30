import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { request } from "../scripts/mcp-server.ts";

it("lets a dog start tasks that run on their own, each answering in its own conversation", async () => {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string) => request(path, {}, session.info.url) as Promise<any>;
  try {
    const olive = (await cli("new-bot", "--name", "Olive")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [olive.id]: {
        steps: [{ tool: "start_tasks", arguments: { tasks: [
          { title: "Flights", instruction: "TASK-FLIGHTS Find flights to Tokyo for Nov 12-19." },
          { title: "Hotel", instruction: "TASK-HOTEL Find a hotel near Shibuya." },
        ] } }],
        reply: "I started two tasks: flights and a hotel.",
        when: [
          { includes: "TASK-FLIGHTS", steps: [{ tool: "start_tasks", expectError: true, arguments: { tasks: [{ title: "More", instruction: "More work" }] } }], reply: "Three flights found." },
          { includes: "TASK-HOTEL", reply: "Two hotels found." },
        ],
      },
    }));
    await cli("send", "--bot", olive.id, "--task", olive.activeTaskId, "--text", "Plan my trip to Tokyo: flights and a hotel.");
    expect((await cli("wait", "--bot", olive.id, "--task", olive.activeTaskId, "--timeout", "30")).status).toBe("settled");

    const started = async () => (await api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === olive.id).tasks.filter((task: any) => task.openedBy);
    await expect.poll(async () => (await started()).filter((task: any) => !task.busy && task.unread).length, { timeout: 30_000 }).toBe(2);
    const tasks = await started();
    expect(tasks.map((task: any) => [task.title, task.openedBy.botId, task.openedBy.kind, task.openedBy.threadId]).sort()).toEqual([
      ["Flights", olive.id, "work", olive.activeTaskId],
      ["Hotel", olive.id, "work", olive.activeTaskId],
    ]);
    for (const [title, marker, answer] of [["Flights", "TASK-FLIGHTS", "Three flights found."], ["Hotel", "TASK-HOTEL", "Two hotels found."]] as const) {
      const task = tasks.find((candidate: any) => candidate.title === title);
      const messages = (await api(`/api/threads/${task.threadId}/messages`)).messages;
      expect(messages.find((message: any) => message.role === "user").text).toContain(marker);
      expect(messages.findLast((message: any) => message.role === "bot" && message.kind === "text").text).toBe(answer);
    }
    const main = (await api(`/api/threads/${olive.activeTaskId}/messages`)).messages;
    expect(main.findLast((message: any) => message.role === "bot" && message.kind === "text").text).toBe("I started two tasks: flights and a hotel.");
    expect(main.some((message: any) => message.text === "Three flights found." || message.text === "Two hotels found.")).toBe(false);

    const turns = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const turnIn = (threadId: string) => turns.find((turn: any) => turn.threadId === threadId);
    const offered = (turn: any) => turn.evidence[0].result.tools.map((tool: { name: string }) => tool.name);
    const startCall = (turn: any) => turn.evidence.find((entry: any) => entry.step?.tool === "start_tasks").response;
    const mainTurn = turnIn(olive.activeTaskId);
    expect(offered(mainTurn)).toContain("start_tasks");
    expect(startCall(mainTurn).result.content[0].text).toContain("Started 2 tasks: “Flights”, “Hotel”.");
    const flights = turnIn(tasks.find((task: any) => task.title === "Flights").threadId);
    expect(offered(flights)).not.toContain("start_tasks");
    expect(startCall(flights).error ?? startCall(flights).result?.isError).toBeTruthy();
  } finally {
    await session.close();
  }
}, 90_000);
