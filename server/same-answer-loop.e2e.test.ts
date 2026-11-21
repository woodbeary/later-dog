import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { SAME_ANSWER_LIMIT } from "./laterdog/same-answer-loop.ts";

type Row = { role: string; kind?: string; text?: string; tool?: { name?: string; ok?: boolean; input?: string } };

async function runLoop(answer: "same" | "changing") {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "repeat-loop", FAKE_CLAUDE_REPEAT_TIMES: "30", FAKE_CLAUDE_REPEAT_GAP_MS: "40", FAKE_CLAUDE_REPEAT_ANSWER: answer });
  const { url } = fixture.info;
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(url + path, { headers: { origin: url } });
    expect(response.ok).toBe(true);
    return response.json() as Promise<T>;
  };
  try {
    const bot = (await get<{ bots: Array<{ id: string; threadId: string; name: string }> }>("/api/bots?messages=0")).bots[0]!;
    await runControlLaterDog(["send", "--url", url, "--bot", bot.id, "--task", bot.threadId, "--text", "Check whether the fixture CLI is signed in"], {});
    const rows = () => get<{ messages: Row[] }>(`/api/threads/${bot.threadId}/messages`).then((body) => body.messages);
    const busy = async () => (await get<{ bots: Array<{ id: string; busy?: boolean }> }>("/api/bots?messages=0")).bots.find((b) => b.id === bot.id)?.busy === true;
    await expect.poll(async () => (await rows()).some((row) => row.role === "user"), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await rows()).some((row) => row.kind === "activity" && /fixture-cli/.test(JSON.stringify(row.tool ?? {}))), { timeout: 20_000 }).toBe(true);
    await expect.poll(busy, { timeout: 30_000, interval: 200 }).toBe(false);
    const messages = await rows();
    return { bot, messages };
  } finally {
    await fixture.close();
  }
}

const loopCalls = (messages: Row[]) => messages.filter((row) => row.kind === "activity" && row.tool?.ok !== false && /fixture-cli auth status/.test(`${row.tool?.name ?? ""} ${row.tool?.input ?? ""}`)).length;
const stopLine = (messages: Row[]) => messages.find((row) => row.kind === "activity" && /got the same answer every time/.test(row.tool?.name ?? ""));

it("ends a turn that keeps getting the same answer from the same call and says what it waits for", async () => {
  const { bot, messages } = await runLoop("same");
  const line = stopLine(messages);
  expect(line?.tool).toMatchObject({ ok: false, name: `error: ${bot.name} stopped: it ran fixture-cli auth status ${SAME_ANSWER_LIMIT} times and got the same answer every time. It is waiting for that answer to change. Reply when it should try again or do something else.` });
  expect(messages.some((row) => /Finished checking/.test(row.text ?? ""))).toBe(false);
  expect(loopCalls(messages)).toBeLessThan(30);
  writeEvidence("same", { line: line?.tool?.name, calls: loopCalls(messages), last: messages.slice(-4).map((row) => ({ kind: row.kind, text: row.text, tool: row.tool?.name })) });
}, 90_000);

it("lets a turn poll a build whose answer keeps changing until it finishes", async () => {
  const { messages } = await runLoop("changing");
  expect(stopLine(messages)).toBeUndefined();
  expect(messages.some((row) => /Finished checking fixture-cli auth status 30 times/.test(row.text ?? ""))).toBe(true);
  writeEvidence("changing", { calls: loopCalls(messages), messages: messages.length });
}, 90_000);

function writeEvidence(name: string, data: unknown) {
  const dir = join(process.cwd(), ".laterdog-evidence", "same-answer-loop");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}
