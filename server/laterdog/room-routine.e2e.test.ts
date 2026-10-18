import { expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";

it("runs a group chat routine as one plain reply from its dog and finishes the run with that reply", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const control = (args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const lead = (await control(["new-bot", "--name", "Lead"])).bot;
    const helper = (await control(["new-bot", "--name", "Helper"])).bot;
    const { group } = await api("POST", "/api/groups", {
      name: "Morning room", memberIds: [lead.id, helper.id],
      setup: { defaultResponder: { kind: "everyone" } },
    }, 201);
    const { routine } = await api("POST", "/api/routines", {
      name: "Morning check", prompt: "Say good morning to the room.", target: "room-goal", groupId: group.id, botId: lead.id,
      runOn: "dog", enabled: false, schedule: { type: "daily", time: "09:00" },
    }, 201);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, {}, 201);

    let finished: any;
    await expect.poll(async () => {
      finished = (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
      return finished?.status;
    }, { timeout: 30_000 }).toBe("completed");
    expect(finished.output).toContain("hello from fake claude");

    const messages = (await api("GET", `/api/threads/${group.threadId}/messages?limit=50`)).messages as any[];
    expect(messages.some((message) => message.kind === "goal.run")).toBe(false);
    expect(messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["Say good morning to the room."]);
    const replies = messages.filter((message) => message.role === "bot" && message.kind === "text");
    expect(replies.map((message) => message.from?.botId)).toEqual([lead.id]);
    expect(replies[0].text).toContain("hello from fake claude");

    const sent = await api("POST", `/api/groups/${group.id}/messages`, { text: "and what about you?", mode: "goal" }, 202);
    expect(sent.message).toMatchObject({ role: "user", text: "and what about you?" });
    expect(sent.message.channelMode).toBeUndefined();
    await control(["wait", "--channel", group.id, "--timeout", "30"]);
    const after = (await api("GET", `/api/threads/${group.threadId}/messages?limit=50`)).messages as any[];
    expect(after.some((message) => message.kind === "goal.run")).toBe(false);
    expect(new Set(after.filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.from?.botId)))
      .toEqual(new Set([lead.id, helper.id]));
  } finally {
    await fixture.close();
  }
}, 90_000);

it("marks a group chat routine failed when its dog finishes without saying anything", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify(["", "", ""]) });
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  try {
    const lead = (await runControlLaterDog(["new-bot", "--name", "Quiet", "--url", fixture.info.url]) as any).bot;
    const { group } = await api("POST", "/api/groups", {
      name: "Quiet room", memberIds: [lead.id], setup: { defaultResponder: { kind: "member", botId: lead.id } },
    }, 201);
    const { routine } = await api("POST", "/api/routines", {
      name: "Quiet check", prompt: "Check in with the room.", target: "room-goal", groupId: group.id, botId: lead.id,
      enabled: false, schedule: { type: "daily", time: "09:00" },
    }, 201);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, {}, 201);
    let finished: any;
    await expect.poll(async () => {
      finished = (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
      return finished?.status;
    }, { timeout: 30_000 }).toBe("failed");
    expect(finished.error).toBe("The dog finished without replying in the group chat.");
    const messages = (await api("GET", `/api/threads/${group.threadId}/messages?limit=50`)).messages as any[];
    expect(messages.filter((message) => message.role === "bot" && message.kind === "text" && message.text?.trim())).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 90_000);
