import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";
import { request } from "../../scripts/mcp-server.ts";

const STEPS = 95;
const calls = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ tool: "list_bots", arguments: {}, toolUseId: `${prefix}-${i + 1}` }));

async function fixture(test: (f: any) => Promise<void>, plan?: (chief: string, lead: string) => Record<string, any>) {
  const out = mkdtempSync(join(tmpdir(), "helper-notice-"));
  const hookOutput = join(out, "hook-output.ndjson");
  const session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_HOOKS: "1", FAKE_CLAUDE_HOOK_OUTPUT: hookOutput, FAKE_CLAUDE_ROOM_MS: "120000" }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Engineering lead", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const toolCalls = Array.from({ length: STEPS }, (_, i) => ({ tool: "list_bots", arguments: {}, toolUseId: `tu-${i + 1}` }));
    const steps: Record<string, any> = {
      [chief.id]: { steps: [{ arguments: { bot_ids: [lead.id], message: "Work through the whole list" } }], reply: "Assigned", resumeReply: "All done" },
      [lead.id]: { steps: toolCalls, reply: "Finished the list" },
    };
    writeFileSync(planPath, JSON.stringify(plan ? plan(chief.id, lead.id) : steps));
    const lines = (): Array<{ id: string; hook: string }> => (existsSync(hookOutput) ? readFileSync(hookOutput, "utf8").trim().split("\n").filter(Boolean) : []).map((line) => JSON.parse(line));
    const hooks = (): string[] => (existsSync(hookOutput) ? readFileSync(hookOutput, "utf8").trim().split("\n").filter(Boolean) : []).map((line) => JSON.parse(line).hook as string);
    const notices = (): string[] => hooks().filter((text) => /partly done/.test(text));
    await test({ cli, api, chief, lead, notices, hooks, lines });
  } finally { await session.close(); }
}

it("a helper asked by a teammate is told at its 80th call and every 10 calls after", () => fixture(async (f) => {
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Please have Engineering work through the whole list.");
  expect((await f.cli("wait", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--timeout", "90")).status).toBe("settled");
  expect(f.hooks()).toHaveLength(STEPS);
  const told = f.notices() as string[];
  expect(told.map((text) => /made (\d+) tool calls/.exec(text)?.[1])).toEqual(["80", "90"]);
}), 150_000);

it("a dog talking to its person is never told", () => fixture(async (f) => {
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "Work through the whole list");
  expect((await f.cli("wait", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--timeout", "90")).status).toBe("settled");
  expect(f.hooks()).toHaveLength(STEPS);
  expect(f.notices()).toEqual([]);
}), 150_000);

it("the dog that sent the request, resumed with its helper's result, is never told", () => fixture(async (f) => {
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Please have Engineering do the small part, then check it.");
  expect((await f.cli("wait", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--timeout", "120")).status).toBe("settled");
  const chief = (f.lines() as Array<{ id: string; hook: string }>).filter((line) => line.id.startsWith("chief-"));
  expect(chief).toHaveLength(STEPS);
  expect(chief.filter((line) => /partly done/.test(line.hook)).map((line) => line.id)).toEqual([]);
}, (chief, lead) => ({
  [chief]: { steps: [{ arguments: { bot_ids: [lead], message: "Do the small part" } }], reply: "Assigned", resumeSteps: calls("chief", STEPS), resumeReply: "All done" },
  [lead]: { steps: calls("helper", 3), reply: "Finished the small part" },
})), 200_000);
