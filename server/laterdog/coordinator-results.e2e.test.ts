import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";

const SOME_BACK = "Some of your downstream room requests have settled";
const ALL_BACK = "Your downstream room requests have settled";

it("gives a coordinator its first helpers' results while a slow one works, then the slow one's, and lets helpers tell each other things", async () => {
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
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(200);
    return result;
  };
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  try {
    const marlow = (await cli("new-bot", "--name", "Marlow", "--section", "Operations")).bot;
    await api("PATCH", `/api/bots/${marlow.id}`, { chiefOfStaff: true });
    const pip = (await cli("new-bot", "--name", "Pip", "--section", "Operations")).bot;
    const quill = (await cli("new-bot", "--name", "Quill", "--section", "Operations")).bot;
    const rook = (await cli("new-bot", "--name", "Rook", "--section", "Operations")).bot;
    const lane = (bot: any, words: string) => ({ tool: "coordinate_bots", arguments: { bot_ids: [bot.id], message: words } });
    const note = (bot: any, words: string) => ({ tool: "coordinate_bots", arguments: { bot_ids: [bot.id], message: words, reply: "none" } });
    writeFileSync(planPath, JSON.stringify({
      [marlow.id]: { when: [
        { includes: SOME_BACK, reply: "Acted on the first two lanes." },
        { includes: ALL_BACK, reply: "All three lanes are in." },
        { includes: "FIELD_NAMES_NOTE", reply: "Noted the field names." },
        { includes: "Split the fixture work", reply: "Sent three lanes.",
          steps: [lane(pip, "Lane one: check the fixture export."), lane(quill, "Lane two: check the fixture copy."), lane(rook, "Lane three: run the long fixture suite.")] },
      ] },
      [pip.id]: { reply: "PIP_LANE_RESULT", steps: [
        note(quill, "FIELD_NAMES_NOTE for Quill: the fields are limitsHit and restingUntil."),
        note(marlow, "FIELD_NAMES_NOTE for Marlow: Quill has the field names now."),
      ] },
      [quill.id]: { when: [
        { includes: "FIELD_NAMES_NOTE", reply: "Quill has the field names." },
        { includes: "Lane two", reply: "QUILL_LANE_RESULT" },
      ] },
      [rook.id]: { gateFile: rookGate, reply: "ROOK_LANE_RESULT" },
    }));
    const marlowTurns = () => turns().filter((turn) => turn.botId === marlow.id);
    const told = (turn: any) => JSON.stringify(turn.prompt);

    await cli("send", "--bot", marlow.id, "--task", marlow.activeTaskId, "--text", "Split the fixture work into three lanes.");

    await expect.poll(() => marlowTurns().find((turn) => told(turn).includes(SOME_BACK)), { timeout: 60_000, interval: 500 }).toBeTruthy();
    const first = marlowTurns().find((turn) => told(turn).includes(SOME_BACK))!;
    expect(told(first)).toContain("PIP_LANE_RESULT");
    expect(told(first)).toContain("QUILL_LANE_RESULT");
    expect(told(first)).not.toContain("ROOK_LANE_RESULT");
    expect(told(first)).toContain("Lane three: run the long fixture suite.");
    expect(nodes().find((node) => node.botId === rook.id)?.status).toBe("running");
    expect(marlowTurns().filter((turn) => told(turn).includes(SOME_BACK))).toHaveLength(1);

    const pipTurn = turns().find((turn) => turn.botId === pip.id)!;
    const notes = pipTurn.evidence.filter((entry: any) => entry.step).map((entry: any) => entry.response.result);
    expect(notes.map((result: any) => Boolean(result.isError))).toEqual([false, false]);
    await expect.poll(() => turns().filter((turn) => turn.botId === quill.id && told(turn).includes("FIELD_NAMES_NOTE")).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => marlowTurns().filter((turn) => told(turn).includes("FIELD_NAMES_NOTE") && !told(turn).includes("downstream room requests")).length, { timeout: 20_000 }).toBe(1);

    writeFileSync(rookGate, "go");
    expect((await cli("wait", "--bot", marlow.id, "--task", marlow.activeTaskId, "--timeout", "60")).status).toBe("settled");
    await expect.poll(() => nodes().find((node) => !node.parentId && node.botId === marlow.id)?.status, { timeout: 20_000 }).toBe("completed");
    const last = marlowTurns().find((turn) => told(turn).includes(ALL_BACK))!;
    expect(told(last)).toContain("ROOK_LANE_RESULT");
    for (const result of ["PIP_LANE_RESULT", "QUILL_LANE_RESULT", "ROOK_LANE_RESULT"]) expect(told(last).split(result).length - 1, result).toBe(1);

    const settled = turns().length;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(turns()).toHaveLength(settled);
    expect(marlowTurns()).toHaveLength(4);
    expect(nodes().every((node) => ["completed", "failed", "cancelled"].includes(node.status))).toBe(true);
    const lines = (await api("GET", `/api/threads/${marlow.activeTaskId}/messages?limit=200`)).messages
      .map((message: any) => message.tool?.name).filter((name: string | undefined) => name?.startsWith("Resumed with"));
    expect(lines).toEqual(["Resumed with Pip, Quill and 1 more results, reviewing"]);
  } finally {
    await fixture.close();
  }
}, 150_000);
