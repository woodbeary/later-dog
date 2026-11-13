import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");
const tokens = (bytes: number) => Math.ceil(bytes / 4);

const PERSON_TURNS = 40;
const REBUILD_TURNS = new Set([0, 20]);
const TOPICS = ["deploys", "taxes", "garden", "pricing"];
const CACHED_CONTEXT_TOKENS = 60_000;
const WRITE_PRICE = { "5m": 1.25, "1h": 2 } as const;

export interface TurnExtras {
  compaction: Array<{ engine: string; window: number; foldBefore: number; foldAfter: string }>;
  recall: { perTurnBytes: number[]; historyBytesBefore: number; historyBytesAfter: number; lastRequestTokensBefore: number; lastRequestTokensAfter: number };
  skillsIndexBytes: number;
  onItNote: { bytes: number; historyBytes: number };
  cache: Array<{ account: string; before: string; after: string; coldStartTokensBefore: number; coldStartTokensAfter: number }>;
}

export async function measureTurnExtras(): Promise<TurnExtras> {
  const home = mkdtempSync(join(tmpdir(), "laterdog-measure-extras-"));
  process.env.LATERDOG_HOME = home;
  try {
    const ws = await import("../server/workspace.ts");
    const recall = await import("../server/recall.ts");
    const skills = await import("../server/skills.ts");
    const work = await import("../server/laterdog/work-updates.ts");
    const budget = await import("../server/context-budget.ts");
    const native = await import("../server/laterdog/native-compaction.ts");
    const cache = await import("../server/laterdog/cache-lifetime.ts");

    const botId = "dog-scout";
    const dir = ws.workspaceDir(botId);
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n" + Array.from({ length: 30 }, (_, i) =>
      `- Fact ${i}: Sam keeps ${TOPICS[i % TOPICS.length]} notes short and checks the budget before paying for anything new.`).join("\n") + "\n");
    for (const topic of TOPICS) {
      writeFileSync(join(dir, "memory", `${topic}.md`), `---\ntitle: ${topic}\ndescription: what Sam decided about ${topic}\n---\n` +
        `Sam decided the ${topic} plan in October. `.repeat(20));
    }
    for (let i = 0; i < 12; i++) {
      skills.installSkill(botId, `fixture/skill-${i}`, [{ path: "SKILL.md",
        content: `---\nname: skill-${i}\ndescription: Does reusable task number ${i}, such as publishing a site or writing release notes.\n---\nBody` }]);
      skills.setSkillEnabled(botId, `skill-${i}`, true);
    }

    const perTurnBytes = Array.from({ length: PERSON_TURNS }, (_, turn) => {
      const topic = TOPICS[turn % TOPICS.length]!;
      const found = recall.buildRecall({
        botId, message: `What did we decide about the ${topic} plan and the budget for it?`, threadIds: [],
        label: () => "an earlier chat", author: () => "Sam",
      });
      return found ? bytesOf(found.text) + 2 : 0;
    });
    const historyBytesBefore = perTurnBytes.reduce((sum, n) => sum + n, 0);
    const historyBytesAfter = perTurnBytes.reduce((sum, n, turn) => sum + (REBUILD_TURNS.has(turn) ? n : 0), 0);
    const sinceRebuild = (keep: (turn: number) => boolean) =>
      perTurnBytes.reduce((sum, n, turn) => sum + (turn >= 20 && keep(turn) ? n : 0), 0);

    const onIt = bytesOf(work.withOnItNote("", "claude")) - 2;

    const compaction = [
      { engine: "claudeAgent", window: 200_000, nativeCompactAt: 200_000 },
      { engine: "claudeAgent", window: 1_000_000, nativeCompactAt: undefined },
      { engine: "codex", window: 272_000, nativeCompactAt: undefined },
      { engine: "pi", window: 128_000, nativeCompactAt: undefined },
    ].map(({ engine, window, nativeCompactAt }) => ({
      engine, window,
      foldBefore: budget.compactBudget(window, undefined, nativeCompactAt),
      foldAfter: native.harnessCompacts(engine, undefined) ? "engine's own default; later.dog summarises only to rebuild a session" : String(budget.compactBudget(window, undefined, nativeCompactAt)),
    }));

    const accounts: Array<{ account: string; env: NodeJS.ProcessEnv; picks: boolean }> = [
      { account: "subscription, Claude Code 2.1.315", env: {}, picks: false },
      { account: "subscription, Claude Code 2.1.316", env: {}, picks: true },
      { account: "API key, Claude Code 2.1.315", env: { ANTHROPIC_API_KEY: "key" }, picks: false },
      { account: "API key, Claude Code 2.1.316", env: { ANTHROPIC_API_KEY: "key" }, picks: true },
    ];
    const cacheRows = accounts.map(({ account, env, picks }) => {
      const paid = cache.paysPerTokenForCache(env);
      const forced = cache.claudeCacheLifetime(env, picks);
      const lifetime = forced ?? (paid ? "5m" : "1h");
      const price = (chosen: "5m" | "1h") => (paid ? Math.round(CACHED_CONTEXT_TOKENS * WRITE_PRICE[chosen]) : 0);
      return { account, before: "1h (set by later.dog)", after: forced ? `${forced} (set by later.dog)` : `${lifetime} (left to Claude Code)`,
        coldStartTokensBefore: price("1h"), coldStartTokensAfter: price(lifetime) };
    });

    return {
      compaction,
      recall: {
        perTurnBytes, historyBytesBefore, historyBytesAfter,
        lastRequestTokensBefore: tokens(sinceRebuild(() => true)), lastRequestTokensAfter: tokens(sinceRebuild((turn) => REBUILD_TURNS.has(turn))),
      },
      skillsIndexBytes: bytesOf(skills.skillsSystemPrompt(botId)),
      onItNote: { bytes: onIt, historyBytes: onIt * PERSON_TURNS },
      cache: cacheRows,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const m = await measureTurnExtras();
  console.log(`Measured on an invented fixture home (${PERSON_TURNS} person turns, sessions started at turns ${[...REBUILD_TURNS].map((t) => t + 1).join(" and ")}); tokens are estimated as bytes / 4.`);
  console.log("\nCompaction: where later.dog folded a chat before, and who compacts now");
  for (const row of m.compaction) console.log(`${row.engine} ${row.window} | before: later.dog folds at ${row.foldBefore} | now: ${row.foldAfter}`);
  const r = m.recall;
  console.log(`\nAuto-recall: ${Math.max(...r.perTurnBytes)} B at most per turn; history added over the chat ${r.historyBytesBefore} B before, ${r.historyBytesAfter} B now; ` +
    `recalled text carried by the last request ~${r.lastRequestTokensBefore} tok before, ~${r.lastRequestTokensAfter} tok now`);
  console.log(`\nSkills index in the stable part: ${m.skillsIndexBytes} B (~${tokens(m.skillsIndexBytes)} tok), unchanged: the engines do not see the workspace's native skill links from the chat folder`);
  console.log(`\nOn-it note: ${m.onItNote.bytes} B per person turn, ${m.onItNote.historyBytes} B over ${PERSON_TURNS} turns, unchanged`);
  console.log(`\nCache lifetime (cold start at ${CACHED_CONTEXT_TOKENS} tokens; token-equivalents billed for the write, 0 where the plan includes it)`);
  for (const row of m.cache) console.log(`${row.account} | before ${row.before}, ${row.coldStartTokensBefore} | now ${row.after}, ${row.coldStartTokensAfter}`);
}
