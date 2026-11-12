import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "laterdog-volatile-measure-"));
process.env.HOME = home;
delete process.env.LATERDOG_HOME;

const sp = await import("../server/system-prompt.ts");
const ws = await import("../server/workspace.ts");
const recent = await import("../server/recent-work.ts");
const usage = await import("../server/laterdog/account-usage.ts");
const notes = await import("../server/laterdog/volatile-sections.ts");

const botId = "bot-measure";
const fact = (i: number) => `- Fact ${i}: the person prefers pnpm, keeps repos under ~/code, wants short replies and checks the hosting grant before spending cash elsewhere (until 2099-01-01).`;
const writeMemory = (facts: number) => ws.writeMemoryFile(botId, "# Memory\n\n" + Array.from({ length: facts }, (_, i) => fact(i)).join("\n") + "\n");
for (const topic of ["deploys", "taxes", "grill"]) ws.writeMemoryTopic(botId, `${topic}.md`, `---\ntitle: ${topic}\ndescription: notes about ${topic}\naliases: ${topic}s\n---\nbody`);

const start = new Date("2026-11-12T10:00:00Z").getTime();
const lines = (generation: number, now: number) => Array.from({ length: 6 }, (_, i) => ({
  threadId: "t" + i,
  at: now - (i + 1) * 60_000,
  where: i % 2 ? "group chat Ops" : "your chat",
  title: `Thread ${i + generation}`,
  said: `Finished the deploy check and posted the summary for item ${i + generation} with the details you asked for.`,
  private: false,
}));

function build(turn: number, usageEvery: number) {
  const now = start + turn * 60_000;
  const recentGeneration = Math.floor(turn / 10);
  writeMemory(30 + Math.floor(turn / 25));
  const left = 80 - Math.floor(turn / usageEvery);
  return sp.buildSystemPrompt("You are Scout, a personal bot in later.dog.", "Be brief.", [
    { id: "today", label: "Today", text: sp.todayPrompt("America/Los_Angeles", new Date(start)) },
    { id: "account", label: "Account", text: usage.USAGE_HANDLED_LINE + ` This turn runs on the claude plan account Claude (person@example.com): session (5-hour) ${left}% left, weekly 60% left. account_usage shows every account; switch_account moves this chat to another.` },
    { id: "recent", label: "Recent work", text: recent.recentWorkPrompt(lines(recentGeneration, start + recentGeneration * 600_000), start + recentGeneration * 600_000) },
    { id: "memory", label: "Memory", text: ws.memorySystemPrompt(botId, { managedWrites: true, fileTools: true }) },
  ], "Pat");
}

function simulate(usageEvery: number, turns = 100) {
  let wholeSeen: string | null = null;
  let sectionSeen: string | null = null;
  let wholeBytes = 0, sectionBytes = 0, wholeSends = 0, sectionSends = 0, wholeRead = 0, sectionRead = 0;
  const stables = new Set<string>();
  for (let turn = 0; turn < turns; turn++) {
    const built = build(turn, usageEvery);
    stables.add(built.stable);
    const whole = notes.claudeVolatileNote(built.volatile, wholeSeen);
    wholeSeen = built.volatile;
    const sectioned = notes.claudeContextNote({ systemVolatile: built.volatile, systemVolatileSections: built.volatileSections }, sectionSeen);
    sectionSeen = sectioned.seen;
    if (whole) { wholeBytes += Buffer.byteLength(whole); wholeSends++; }
    if (sectioned.note) { sectionBytes += Buffer.byteLength(sectioned.note); sectionSends++; }
    wholeRead += wholeBytes / 4;
    sectionRead += sectionBytes / 4;
  }
  return {
    usageChangesEveryNTurns: usageEvery,
    stablePartVariants: stables.size,
    before: { sends: wholeSends, bytes: wholeBytes, historyTokensAtEnd: Math.round(wholeBytes / 4), cacheReadTokensSummed: Math.round(wholeRead) },
    after: { sends: sectionSends, bytes: sectionBytes, historyTokensAtEnd: Math.round(sectionBytes / 4), cacheReadTokensSummed: Math.round(sectionRead) },
    saved: `${(100 * (1 - sectionBytes / wholeBytes)).toFixed(1)}%`,
  };
}

const first = build(0, 3);
const result = {
  label: "measured on fixture: 100-turn main-dog chat; recent work changes every 10 turns, memory every 25, date never; tokens = bytes / 4",
  volatileBytes: Buffer.byteLength(first.volatile),
  sections: first.volatileSections.map((section) => [section.id, Buffer.byteLength(section.text)]),
  runs: [1, 3, 10, 1000].map((every) => simulate(every)),
};
rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 1));
