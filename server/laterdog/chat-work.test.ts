import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RoomHandoffs, type RoomHandoffHooks } from "../room-handoffs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { directHandoffFacts, olderWorkFields } from "./chat-work.ts";
import { workState } from "./work-state.ts";

const dir = mkdtempSync(join(tmpdir(), "chat-work-"));
afterAll(() => removeTempDir(dir));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const chief = { botId: "chief", threadId: "chief-chat" };
const scout = { botId: "scout", threadId: "scout-chat" };

function handoffs(name: string, busy: (botId: string) => boolean) {
  const hooks: RoomHandoffHooks = { validate: () => undefined, busy: (node) => busy(node.botId), run: () => new Promise(() => {}), report: () => {}, changed: () => {} };
  return new RoomHandoffs(join(dir, `${name}.json`), hooks);
}

describe("a chat's handoffs, from the handoff record", () => {
  it("a handoff waiting in line for a busy dog is not shown as waiting on anyone, in either chat", async () => {
    const record = handoffs("queued", (botId) => botId === "scout");
    record.enqueue(chief, "turn", undefined, scout, "fyi", "Ship it", false, false, "", undefined, undefined, undefined, undefined, false, "none");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    expect(record.activeDirect(scout.threadId)).toBe(true);
    for (const threadId of [chief.threadId, scout.threadId]) {
      const facts = directHandoffFacts(threadId, record.nodes.values());
      expect(facts).toEqual({ awaited: [], working: false });
      const work = workState({ busy: false, handoffRunning: facts.working, waitingOn: [] });
      expect(work).toEqual({ kind: "idle" });
      expect(olderWorkFields(work, false, "idle", []).waitingForTeammates).toBe(false);
    }
  });

  it("the dog doing the handoff is running, and the one that asked for a reply waits on it by name", async () => {
    const record = handoffs("running", () => false);
    record.enqueue(chief, "turn", undefined, scout, "check", "Check the totals");
    record.sourceSettled("turn", true);
    record.tick(); await flush();
    expect(directHandoffFacts(scout.threadId, record.nodes.values()).working).toBe(true);
    const asked = directHandoffFacts(chief.threadId, record.nodes.values());
    expect(asked.working).toBe(false);
    expect(asked.awaited.map((node) => node.botId)).toEqual(["scout"]);
  });
});

describe("the older fields say what the work state says", () => {
  const scoutWaiting = [{ botId: "scout", name: "Scout", state: "running" as const }];

  it("only a chat waiting on a dog says it waits for teammates, and names them", () => {
    const waiting = workState({ busy: false, waitingOn: scoutWaiting });
    expect(olderWorkFields(waiting, false, "idle", scoutWaiting)).toEqual({ activity: "idle", waitingForTeammates: true, waitingOn: scoutWaiting });
    const asking = workState({ busy: false, waitingOn: scoutWaiting, needsYou: {} });
    expect(olderWorkFields(asking, false, "idle", scoutWaiting)).toEqual({ activity: "waiting-on-you", waitingForTeammates: false });
  });

  it("counts helpers and computer jobs as helpers working once the turn has ended", () => {
    const work = workState({ busy: false, helpers: 1, computerJobs: 2 });
    expect(olderWorkFields(work, false, "idle", undefined)).toEqual({ activity: "idle", waitingForTeammates: false, helpersWorking: 3 });
  });

  it("never says working when nothing runs", () => {
    expect(olderWorkFields(workState({ busy: false }), false, "working", undefined).activity).toBe("idle");
    expect(olderWorkFields(workState({ busy: true }), true, "working", undefined).activity).toBe("working");
  });
});
