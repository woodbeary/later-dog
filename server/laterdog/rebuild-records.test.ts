import { expect, it } from "vitest";

import { openHandoffsFromRoom, RECORDS_LABEL, recordsText, personOwes, withRecords, type OpenHandoffsOf } from "./rebuild-records.ts";

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
    ], "Sam"),
  })!;
  expect(text).toContain("- Move the bakery site to port 9001 (in progress)");
  expect(text).toContain("- Review Crumb's menu rewrite (not started)");
  expect(text).toContain("- Crumb (working): Rewrite the menu page and keep menu-old.html");
  expect(text).toContain("- another dog (waiting its turn): Check the oven timer");
  expect(text).toContain("Its result arrived and is not yet read: Sourdough at 7.50, rye at 6.25.");
  expect(text).toContain("- Question: Publish the site?");
  expect(text).not.toContain("Already answered");
  expect(text).toContain("Asked in the last reply: Should I delete the old menu?");
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
