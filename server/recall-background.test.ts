import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, closeMessageSearch, indexMemoryFile, insertMessage } from "./message-db.ts";
import { buildRecallInBackground, topicPassagesFrom } from "./recall.ts";

const BOT = "bot-recall-background";

beforeEach(async () => {
  await closeMessageSearch();
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(async () => { await closeMessageSearch(); closeMessageDb(); });

const input = (threadIds: string[]) => ({
  botId: BOT, message: "which dentist appointment did we book for the kids", threadIds,
  label: (id: string) => `chat ${id}`, author: (hit: { role: string }) => hit.role === "user" ? "Jacob" : "Rex",
});

it("finds notes and conversation passages from the search index, without reading the dog's folder", async () => {
  insertMessage("chat-a", { id: "m1", at: Date.UTC(2026, 10, 20), role: "user", kind: "text", text: "Book the kids' dentist appointment for Friday at Smile Dental" });
  insertMessage("chat-b", { id: "m2", at: Date.UTC(2026, 10, 21), role: "user", kind: "text", text: "unrelated grocery list" });
  indexMemoryFile(BOT, "memory/family.md", "The kids' dentist is Smile Dental; appointment every six months", { mtimeMs: 1, bytes: 64 });
  const recalled = await buildRecallInBackground(input(["chat-a", "chat-b"]));
  expect(recalled?.text).toContain("Smile Dental");
  expect(recalled).toMatchObject({ notes: 1, conversations: 1 });
  expect(recalled?.text).toContain("memory/family.md");
  const hidden = await buildRecallInBackground({ ...input(["chat-a"]), mayShow: () => false });
  expect(hidden).toMatchObject({ conversations: 0 });
  const docs = new Map([["memory/dentist.md", "---\ntitle: Dentist\ndescription: kids' dentist visits\n---\nSmile Dental, every six months"], ["memory/archive.md", "dentist"]]);
  expect(topicPassagesFrom(docs, "when is the kids dentist").map((passage) => passage.label)).toEqual(["memory/dentist.md"]);
});

it("keeps the server answering while recall searches a large history", async () => {
  for (let n = 0; n < 40_000; n++) {
    insertMessage(`chat-${n % 200}`, { id: `m${n}`, at: n, role: n % 2 ? "bot" : "user", kind: "text", text: `note ${n} about the dentist appointment booking and the kids schedule ${"filler ".repeat(20)}` });
  }
  let worst = 0;
  let last = Date.now();
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
  try {
    await Promise.all([1, 2, 3].map(() => buildRecallInBackground(input(Array.from({ length: 200 }, (_, n) => `chat-${n}`)))));
  } finally { clearInterval(tick); }
  expect(worst).toBeLessThan(100);
}, 60_000);
