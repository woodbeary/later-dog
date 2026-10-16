import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";
import { PROMISE_NUDGE } from "./promise-nudge.ts";

const CLAUDE = { instanceId: "claude", model: "claude-sonnet-5" };
const REPLIES = [
  "I'm checking Cloudflare on your cloud computer.",
  "Cloudflare is healthy: the Worker answers on every route.",
  "Should I also check the DNS records?",
  "I'm checking the DNS records now.",
  "This reply must never be asked for.",
];

it.skipIf(process.platform === "win32")("carries an Off-leash dog on once when its turn ends on a promise, and never a Heel dog or a question", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-promise-"));
  const promptsPath = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_MODE: "happy",
    FAKE_CLAUDE_REPLIES: JSON.stringify(REPLIES),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_PROMPTS: promptsPath,
  });
  const { url, logPath } = fixture.info;
  const evidence: unknown[] = [{ url }];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  const prompts = (): string[] => existsSync(promptsPath)
    ? readFileSync(promptsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.stringify(JSON.parse(line)))
    : [];
  const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
  const replies = async (threadId: string) => {
    const all = await messages(threadId);
    return all.slice(all.findIndex((message) => message.role === "user")).filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text);
  };
  const busy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === botId)?.busy === true;
  try {
    const { bot: offLeash } = await control("new-bot", "--name", "Scout");
    const thread = offLeash.activeTaskId as string;
    await api("PATCH", `/api/bots/${offLeash.id}/tasks/${thread}`, { modelSelection: CLAUDE, updateBotDefault: true });
    await api("PATCH", `/api/bots/${offLeash.id}/tasks/${thread}`, { approvalMode: "auto", acknowledgeLocalAuto: true });

    await control("send", "--bot", offLeash.id, "--task", thread, "--text", "Is Cloudflare healthy?");
    await expect.poll(() => replies(thread), { timeout: 30_000, interval: 250 }).toEqual([REPLIES[0], REPLIES[1]]);
    await expect.poll(() => busy(offLeash.id), { timeout: 20_000 }).toBe(false);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain(JSON.stringify(PROMISE_NUDGE).slice(1, -1));
    const afterFirst = await messages(thread);
    expect(afterFirst.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["Is Cloudflare healthy?"]);
    evidence.push({ promise: afterFirst });

    await control("send", "--bot", offLeash.id, "--task", thread, "--text", "Check the DNS too.");
    await expect.poll(() => replies(thread), { timeout: 30_000, interval: 250 }).toContain(REPLIES[2]);
    await expect.poll(() => busy(offLeash.id), { timeout: 20_000 }).toBe(false);

    const { bot: heel } = await control("new-bot", "--name", "Heeler");
    await api("PATCH", `/api/bots/${heel.id}/tasks/${heel.activeTaskId}`, { modelSelection: CLAUDE, updateBotDefault: true });
    await control("send", "--bot", heel.id, "--task", heel.activeTaskId, "--text", "Look at the DNS.");
    await expect.poll(() => replies(heel.activeTaskId), { timeout: 30_000, interval: 250 }).toEqual([REPLIES[3]]);
    await expect.poll(() => busy(heel.id), { timeout: 20_000 }).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(prompts()).toHaveLength(4);
    expect(prompts().filter((prompt) => prompt.includes("none of it has happened yet"))).toHaveLength(1);
    evidence.push({ prompts: prompts() });
  } finally {
    const evidencePath = `${logPath}.promise-nudge.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
    console.info(JSON.stringify({ logPath, evidencePath }));
  }
}, 120_000);
