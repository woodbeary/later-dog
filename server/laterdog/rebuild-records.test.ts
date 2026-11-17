import { expect, it } from "vitest";

import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RoomHandoffs } from "../room-handoffs.ts";
import { removeTempDir } from "../testing/cleanup.ts";

import { assignedTask, openHandoffsFromRoom, ownLastAsk, OWN_ASK_LABEL, RECORDS_LABEL, recordsText, personOwes, withRecords, type OpenHandoffsOf, type TaskNode } from "./rebuild-records.ts";

const names: Record<string, string> = { crumb: "Crumb", rye: "Rye" };

it("tells a rebuilt dog its plan, its open handoffs with any unread result, and what the person owes it", () => {
  const handoffsOf: OpenHandoffsOf = () => [
    ...openHandoffsFromRoom([
      { botId: "crumb", text: "Rewrite the menu page and keep menu-old.html", status: "running" },
      { botId: "gone", text: "Check the oven timer", status: "queued" },
    ], (id) => names[id]),
    { to: "Rye", task: "Price the new loaves", state: "done", unreadResult: "Sourdough at 7.50, rye at 6.25." },
  ];
  const text = recordsText({
    plan: [{ text: "Move the bakery site to port 9001", status: "in_progress" }, { text: "Review Crumb's menu rewrite", status: "pending" }],
    handoffs: handoffsOf("coordinator", "thread"),
    waiting: personOwes([
      { role: "user", kind: "text", text: "Go ahead." },
      { role: "bot", kind: "options", card: { title: "Publish the site?", subtitle: "", options: ["Yes", "No"], requestType: "question" } },
      { role: "bot", kind: "options", card: { title: "Already answered", subtitle: "", options: ["Yes"], answered: "Yes" } },
      { role: "bot", kind: "text", text: "Done with the port. Should I delete the old menu?" },
    ]),
  })!;
  expect(text).toContain("- Move the bakery site to port 9001 (in progress)");
  expect(text).toContain("- Review Crumb's menu rewrite (not started)");
  expect(text).toContain("- Crumb (working): Rewrite the menu page and keep menu-old.html");
  expect(text).toContain("- another dog (waiting its turn): Check the oven timer");
  expect(text).toContain("Its result arrived and is not yet read: Sourdough at 7.50, rye at 6.25.");
  expect(text).toContain("- Question: Publish the site?");
  expect(text).not.toContain("Already answered");
  expect(text).not.toContain("Should I delete the old menu?");
  expect(text).not.toContain("Asked in the last reply");
});

const node = (extra: Partial<TaskNode> & Pick<TaskNode, "id" | "botId" | "threadId">): TaskNode => ({ text: "", status: "running", ...extra });

it("gives a helper dog its own task back: what it was asked and by whom, from the handoff record", () => {
  const nodes = new Map<string, TaskNode>(([
    node({ id: "src", botId: "coord", threadId: "coord-chat", status: "source", text: "Move the bakery site" }),
    node({ id: "job", botId: "crumb", threadId: "crumb-chat", parentId: "src", text: "Rewrite the menu page and keep menu-old.html" }),
    node({ id: "old", botId: "crumb", threadId: "crumb-chat", parentId: "src", status: "completed", text: "An earlier, finished job" }),
  ]).map((entry) => [entry.id, entry]));
  const assigned = assignedTask(nodes, "crumb-chat", (id) => ({ coord: "Coordinator" })[id]);
  expect(assigned).toEqual({ task: "Rewrite the menu page and keep menu-old.html", by: "Coordinator" });
  expect(recordsText({ assigned, handoffs: [], waiting: [] })).toBe("Your task, as Coordinator asked it of you: Rewrite the menu page and keep menu-old.html");
  expect(assignedTask(nodes, "coord-chat", () => undefined)).toBeUndefined();
  expect(assignedTask(nodes, "nobody-chat", () => undefined)).toBeUndefined();
  expect(assignedTask(nodes, "crumb-chat", () => undefined)?.by).toBe("another dog");
});

it("labels the line quoted from the dog's own last reply as its own message, outside the home's records", () => {
  const messages = [
    { role: "user" as const, kind: "text" as const, text: "Go ahead." },
    { role: "bot" as const, kind: "text" as const, text: "Done with the port. Should I delete the old menu?" },
  ];
  expect(ownLastAsk(messages, "Sam")).toBe("Should I delete the old menu?");
  expect(ownLastAsk([...messages, { role: "user", kind: "text", text: "Yes." }], "Sam")).toBeNull();
  const built = withRecords([{ id: "a", role: "user", text: "hello" }], "Your plan", "Should I delete the old menu?");
  expect(built.map(({ text }) => text)).toEqual(["hello", `${OWN_ASK_LABEL}\nShould I delete the old menu?`, `${RECORDS_LABEL}\nYour plan`]);
  expect(built.at(-1)!.text).not.toContain("Should I delete");
});

it("is wired to the home's handoff record and the dog's own last reply when a turn is rebuilt", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(source).toContain("assigned: assignedTask(roomHandoffs.nodes, threadId");
  expect(source).toContain("ownLastAsk(activeMessages, cfg.profile?.name)");
});

it("says nothing when the records hold nothing, and stays bounded when they hold a lot", () => {
  expect(recordsText({ handoffs: [], waiting: [] })).toBeNull();
  const many = Array.from({ length: 40 }, (_, i) => ({ to: `Dog ${i}`, task: "x".repeat(500), state: "working" }));
  const text = recordsText({ handoffs: many, waiting: Array.from({ length: 20 }, (_, i) => `ask ${i}`) })!;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4_000);
  expect(text).toContain("Dog 0");
});

it("puts the records last in a rebuilt transcript, labelled as records, and leaves the transcript alone when there are none", () => {
  const transcript = [{ id: "a", role: "user" as const, text: "hello" }];
  expect(withRecords(transcript, null)).toEqual(transcript);
  const built = withRecords(transcript, "Your plan");
  expect(built.at(-1)).toEqual({ id: "", role: "assistant", text: `${RECORDS_LABEL}\nYour plan` });
  expect(transcript).toHaveLength(1);
});

it("tells a rebuilt dog which results are back but not yet given to it, the moment a helper finishes", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "rebuild-handed-"));
  const finishers = new Map<string, (result: { ok: boolean; text: string }) => void>();
  try {
    const engine = new RoomHandoffs(join(dir, "handoffs.json"), {
      validate: () => undefined, busy: () => false, report: () => {}, changed: () => {},
      run: (node) => new Promise((resolve) => finishers.set(node.botId, resolve)),
    });
    const lead = { botId: "lead", threadId: "lead-chat" };
    engine.enqueue(lead, "turn", undefined, { botId: "crumb", threadId: "crumb-chat" }, "menu", "Rewrite the menu page");
    engine.enqueue(lead, "turn", undefined, { botId: "rye", threadId: "rye-chat" }, "price", "Price the new loaves");
    engine.sourceSettled("turn", true);
    engine.tick();
    await new Promise((resolve) => setImmediate(resolve));
    finishers.get("rye")?.({ ok: true, text: "Sourdough at 7.50." });
    await new Promise((resolve) => setImmediate(resolve));
    const text = recordsText({ handoffs: openHandoffsFromRoom(engine.handedOut("lead-chat"), (id) => names[id]), waiting: [] })!;
    expect(text).toContain("- Crumb (working): Rewrite the menu page");
    expect(text).toContain("- Rye (finished): Price the new loaves");
    expect(text).toContain("Its result arrived and is not yet read: Sourdough at 7.50.");
    expect(engine.handedOut("crumb-chat")).toEqual([]);
  } finally { await removeTempDir(dir); }
});
