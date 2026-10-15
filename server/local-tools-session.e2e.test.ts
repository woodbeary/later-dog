import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-laterdog.ts";
import { LOCAL_TOOLS_REFUSAL } from "./laterdog/local-tools-scope.ts";

const OWNER = "o".repeat(43);

it("lets an apps session list dogs and send messages, refuses it approvals, answers, settings and pairing, and never lets its message answer a card; a phone is unchanged", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-laterdog-desktop-owner": OWNER } });
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang", LATERDOG_TEST_DESKTOP_OWNER_TOKEN: OWNER })
    .finally(() => { globalThis.fetch = realFetch; });
  const url = fixture.info.url;
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const owner = { "x-laterdog-desktop-owner": OWNER };
  const signIn = async (label: string, extra: Record<string, unknown> = {}) => {
    const opened = await api("POST", "/api/auth/pairing", { label: "later.dog Cloud" }, owner);
    expect(opened.status).toBe(200);
    const paired = await api("POST", "/api/auth/pair", { code: opened.body.credential, label, ...extra });
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    return paired.body as { token: string; session: { id: string; label: string; localTools?: true } };
  };
  let socket: Socket | undefined;
  console.log(`apps session fixture: ${fixture.info.logPath}`);
  try {
    expect((await api("POST", "/api/auth/pair", { code: "ABCD-EFGH-JKLM", localTools: "yes" })).status).toBe(400);
    expect((await api("POST", "/api/auth/pair", { code: "ABCD-EFGH-JKLM", localTools: true, browser: true, cookie: true })).status).toBe(400);

    const apps = await signIn("Apps on this Mac", { localTools: true });
    expect(apps.session).toMatchObject({ label: "Apps on this Mac", localTools: true });
    const phone = await signIn("iPhone");
    expect(phone.session).not.toHaveProperty("localTools");
    const asApps = { authorization: `Bearer ${apps.token}` };
    const asPhone = { authorization: `Bearer ${phone.token}` };

    const made = await api("POST", "/api/bots", { name: "Apps dog", title: "Made by an app" }, asApps);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const botId = made.body.bot.id as string;
    const threadId = made.body.bot.threadId as string;
    const bots = async () => (await api("GET", "/api/bots?messages=0", undefined, asApps)).body.bots as any[];
    const state = async () => (await bots()).find((candidate) => candidate.id === botId);
    expect(await state()).toMatchObject({ name: "Apps dog", title: "Made by an app" });
    expect((await state()).approvalMode ?? "ask").toBe("ask");
    expect((await state()).autoApprove).not.toBe(true);
    const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`, undefined, asApps)).body.messages;

    const sent = await api("POST", `/api/bots/${botId}/messages`, { text: "work for a while", threadId }, asApps);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(async () => (await messages()).find((message) => message.text === "work for a while")?.via, { timeout: 15_000 }).toBe("api");
    await expect.poll(async () => Boolean((await state())?.busy), { timeout: 15_000 }).toBe(true);

    for (const [method, path, body] of [
      ["POST", `/api/bots/${botId}/respond`, { threadId, requestId: "r", behavior: "allow" }],
      ["POST", `/api/threads/${threadId}/respond`, { requestId: "r", behavior: "allow" }],
      ["PATCH", `/api/bots/${botId}/cards/c1`, { answered: "allow" }],
      ["POST", `/api/bots/${botId}/always-allow`, { key: "Bash" }],
      ["PATCH", `/api/bots/${botId}`, { approvalMode: "auto" }],
      ["PATCH", `/api/bots/${botId}/tasks/${threadId}`, { approvalMode: "full" }],
      ["POST", "/api/bots", { name: "Sneaky", approvalMode: "auto" }],
      ["PUT", "/api/config", { signIn: { admins: ["someone@example.test"] } }],
      ["PATCH", "/api/config", { newBotDefaults: { profile: { approvalMode: "full" } } }],
      ["POST", "/api/auth/pairing", { label: "Another" }],
      ["DELETE", `/api/auth/sessions/${phone.session.id}`, undefined],
      ["POST", "/api/auth/stream-ticket", {}],
    ] as Array<[string, string, unknown]>) {
      const refused = await api(method, path, body, asApps);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.body.error, `${method} ${path}`).toContain(LOCAL_TOOLS_REFUSAL);
    }
    expect((await api("GET", "/api/auth/session", undefined, asPhone)).status).toBe(200);

    await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.dog?.args[1]; } catch { return undefined; }
    }, { timeout: 10_000 }).toEqual(expect.any(String));
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    socket = connect(dump.mcpConfig.mcpServers.dog.args[1]);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
    const requestId = randomUUID();
    socket.write(JSON.stringify({
      t: "ask", kind: "question", id: requestId, tool: "AskUserQuestion",
      input: { questions: [{ question: "Which file should I update?", options: [{ label: "README" }, { label: "Guide" }] }] },
    }) + "\n");
    await expect.poll(async () => (await messages()).find((message) => message.card?.requestId === requestId), { timeout: 10_000 }).toBeTruthy();
    const card = async () => (await messages()).find((message) => message.card?.requestId === requestId)!.card;

    const typedByApps = await api("POST", `/api/bots/${botId}/messages`, { text: "README", threadId }, asApps);
    expect(typedByApps.status, JSON.stringify(typedByApps.body)).toBe(202);
    expect((await card()).answered).toBeUndefined();
    expect((await card()).answeredBy).toBeUndefined();

    const typedByPhone = await api("POST", `/api/bots/${botId}/messages`, { text: "Guide", threadId }, asPhone);
    expect(typedByPhone.status, JSON.stringify(typedByPhone.body)).toBe(202);
    await expect.poll(async () => (await card()).answered, { timeout: 10_000 }).toBe("answer");
    expect((await card()).answeredBy).toMatchObject({ kind: "session", name: "iPhone" });

    const stopped = await api("POST", `/api/bots/${botId}/interrupt`, { threadId }, asApps);
    expect(stopped.status, JSON.stringify(stopped.body)).toBeLessThan(300);
    await expect.poll(async () => Boolean((await state())?.busy), { timeout: 15_000 }).toBe(false);
    const another = await api("POST", "/api/auth/pairing", { label: "Another" }, asPhone);
    expect(another.status).toBe(200);
  } finally {
    socket?.destroy();
    await fixture.close();
  }
}, 120_000);
