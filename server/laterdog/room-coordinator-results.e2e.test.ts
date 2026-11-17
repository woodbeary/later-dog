import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";

const SOME_BACK = "Some of your downstream room requests have settled";
const ALL_BACK = "Your downstream room requests have settled";

it("gives a coordinator in a group chat the results of work it sent to another room as they come, each once, with one row", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const rookGate = join(dataDir, "rook.gate");
  const turns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const nodes = (): any[] => existsSync(join(dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8")) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  try {
    const marlow = (await cli("new-bot", "--name", "Marlow", "--section", "Operations")).bot;
    await api("PATCH", `/api/bots/${marlow.id}`, { chiefOfStaff: true });
    const pip = (await cli("new-bot", "--name", "Pip", "--section", "Operations")).bot;
    const quill = (await cli("new-bot", "--name", "Quill", "--section", "Operations")).bot;
    const rook = (await cli("new-bot", "--name", "Rook", "--section", "Operations")).bot;
    const { group } = await api("POST", "/api/groups", {
      name: "Fixture room", memberIds: [marlow.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: marlow.id } },
    });
    const { group: crew } = await api("POST", "/api/groups", {
      name: "Crew room", memberIds: [pip.id, quill.id, rook.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: pip.id } },
    });
    const lane = (bot: any, words: string) => ({ tool: "coordinate_bots", arguments: { group_id: crew.id, bot_ids: [bot.id], message: words } });
    writeFileSync(planPath, JSON.stringify({
      [marlow.id]: { when: [
        { includes: SOME_BACK, reply: "Acted on the first two lanes." },
        { includes: ALL_BACK, reply: "All three lanes are in." },
        { includes: "Split the room work", reply: "Sent three lanes.",
          steps: [lane(pip, "Lane one: check the room export."), lane(quill, "Lane two: check the room copy."), lane(rook, "Lane three: run the long room suite.")] },
      ] },
      [pip.id]: { reply: "PIP_ROOM_RESULT" },
      [quill.id]: { reply: "QUILL_ROOM_RESULT" },
      [rook.id]: { gateFile: rookGate, reply: "ROOK_ROOM_RESULT" },
    }));
    const marlowTurns = () => turns().filter((turn) => turn.botId === marlow.id);
    const told = (turn: any) => JSON.stringify(turn.prompt);

    await api("POST", `/api/groups/${group.id}/messages`, { text: "Split the room work into three lanes." });

    await expect.poll(() => marlowTurns().find((turn) => told(turn).includes(SOME_BACK)), { timeout: 60_000, interval: 500 }).toBeTruthy();
    const first = marlowTurns().find((turn) => told(turn).includes(SOME_BACK))!;
    expect(told(first)).toContain("PIP_ROOM_RESULT");
    expect(told(first)).toContain("QUILL_ROOM_RESULT");
    expect(told(first)).not.toContain("ROOK_ROOM_RESULT");
    expect(nodes().find((node) => node.botId === rook.id)?.status).toBe("running");

    writeFileSync(rookGate, "go");
    await expect.poll(() => nodes().find((node) => !node.parentId && node.botId === marlow.id)?.status, { timeout: 60_000, interval: 500 }).toBe("completed");
    const last = marlowTurns().find((turn) => told(turn).includes(ALL_BACK))!;
    expect(told(last)).toContain("ROOK_ROOM_RESULT");
    expect(marlowTurns().filter((turn) => told(turn).includes(SOME_BACK))).toHaveLength(1);
    expect(marlowTurns().filter((turn) => told(turn).includes(ALL_BACK))).toHaveLength(1);
    const settled = turns().length;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(turns()).toHaveLength(settled);
    expect(nodes().every((node) => ["completed", "failed", "cancelled"].includes(node.status))).toBe(true);
    const lines = (await api("GET", `/api/threads/${group.threadId}/messages?limit=200`)).messages
      .map((message: any) => message.tool?.name).filter((name: string | undefined) => name?.startsWith("Resumed with"));
    expect(lines).toEqual(["Resumed with Pip, Quill and 1 more results, reviewing"]);
  } finally {
    await fixture.close();
  }
}, 150_000);
