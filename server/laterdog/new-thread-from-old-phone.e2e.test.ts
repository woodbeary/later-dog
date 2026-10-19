import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../../scripts/control-laterdog.ts";
import type { GroupTask, WireBot, WireGroup } from "../../shared/wire.ts";

let fixture: VerificationServer;

const api = async <T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as T;
  expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
  return result;
};
const listed = () => api<{ bots: WireBot[]; groups: WireGroup[] }>("GET", "/api/bots?messages=0");
const savedFile = <T>(name: string) => JSON.parse(readFileSync(join(fixture.info.dataDir, name), "utf8")) as T;

beforeAll(async () => {
  fixture = await launchVerificationServer();
});
afterAll(async () => {
  await fixture?.close();
});

it("New Thread from an old phone adds a thread without moving the dog's one conversation", async () => {
  const { bot } = await api<{ bot: WireBot }>("POST", "/api/bots", { name: "Old phone dog" }, 201);
  const created = await api<{ bot: WireBot; task: { threadId: string; title: string } }>(
    "POST", `/api/bots/${bot.id}/tasks`, { title: "From the old phone" }, 201);

  expect(created.task.threadId).not.toBe(bot.threadId);
  expect(created.task.title).toBe("From the old phone");
  expect(created.bot.threadId).toBe(bot.threadId);
  const shown = (await listed()).bots.find((candidate) => candidate.id === bot.id)!;
  expect(shown.threadId).toBe(bot.threadId);
  expect(shown.tasks?.map((task) => task.threadId)).toContain(created.task.threadId);
  expect(savedFile<Array<{ id: string; threadId: string }>>("bots.json").find((candidate) => candidate.id === bot.id)?.threadId)
    .toBe(bot.threadId);
});

it("a new task in a group chat from an old phone leaves the group on its conversation", async () => {
  const { bot } = await api<{ bot: WireBot }>("POST", "/api/bots", { name: "Old phone room member" }, 201);
  const { group } = await api<{ group: WireGroup }>("POST", "/api/groups", {
    name: "Old phone room", memberIds: [bot.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
  }, 201);
  const created = await api<{ group: WireGroup; task: GroupTask }>("POST", `/api/groups/${group.id}/tasks`, { title: "Side task" }, 201);

  expect(created.task.threadId).not.toBe(group.threadId);
  expect(created.group.threadId).toBe(group.threadId);
  const shown = (await listed()).groups.find((candidate) => candidate.id === group.id)!;
  expect(shown.threadId).toBe(group.threadId);
  expect(shown.tasks?.map((task) => task.threadId)).toContain(created.task.threadId);
  expect(savedFile<Array<{ id: string; threadId: string }>>("groups.json").find((candidate) => candidate.id === group.id)?.threadId)
    .toBe(group.threadId);
});
