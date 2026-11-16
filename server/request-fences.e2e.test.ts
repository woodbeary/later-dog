import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { request } from "../scripts/mcp-server.ts";

it("leaves no request in either chat marked as still going once a team task has ended", async () => {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string) => request(path, {}, session.info.url) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Chief")).bot;
    const scout = (await cli("new-bot", "--name", "Scout")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [chief.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [scout.id], request_key: "look", message: "FENCE_BRIEF look into the meadow" } }], reply: "Asked Scout to look" },
        { expectContextIncludes: ["SCOUT_FOUND_TWO"], reply: "Scout found two" },
      ] },
      [scout.id]: { when: [
        { includes: "FENCE_HELLO", reply: "Hello back" },
        { includes: "FENCE_BRIEF", reply: "SCOUT_FOUND_TWO" },
      ] },
    }));
    const pending = async (threadId: string) => (await api(`/api/threads/${threadId}/messages?limit=100`)).messages
      .filter((message: any) => message.role === "user" && message.requestPending === true).map((message: any) => message.text);

    await cli("send", "--bot", scout.id, "--task", scout.activeTaskId, "--text", "FENCE_HELLO are you there");
    expect((await cli("wait", "--bot", scout.id, "--task", scout.activeTaskId, "--timeout", "30")).status).toBe("settled");
    expect(await pending(scout.activeTaskId)).toEqual([]);

    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Ask Scout to look into the meadow.");
    expect((await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30")).status).toBe("settled");
    await expect.poll(() => (JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8")) as any[])
      .every((node) => node.status === "completed"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => pending(scout.activeTaskId), { timeout: 10_000 }).toEqual([]);
    expect(await pending(chief.activeTaskId)).toEqual([]);
    const hello = (await api(`/api/threads/${scout.activeTaskId}/messages?limit=100`)).messages
      .find((message: any) => message.role === "user" && message.text === "FENCE_HELLO are you there");
    expect(hello).toMatchObject({ requestPending: false });
    expect(hello.requestCancelled).not.toBe(true);
  } finally {
    await session.close();
  }
}, 90_000);
