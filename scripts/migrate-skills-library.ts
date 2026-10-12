import { resolve } from "node:path";

const args = process.argv.slice(2);
const dataDirFlag = args.indexOf("--data-dir");
if (dataDirFlag !== -1 && (!args[dataDirFlag + 1]?.trim() || args[dataDirFlag + 1]!.startsWith("-"))) {
  console.error("Usage: migrate-skills-library.ts [--data-dir <dir>]");
  process.exit(2);
}
const dataDir = dataDirFlag !== -1 ? resolve(args[dataDirFlag + 1]!) : undefined;
if (dataDir) process.env.LATERDOG_HOME = dataDir;

const { botIdsWithSkillState, migrateBotSkillsToLibrary, readPendingAssignments, writePendingAssignments } =
  await import("../server/skills-library-migration.ts");
const { DATA_DIR } = await import("../server/config.ts");

const pending = readPendingAssignments();
const outcomes = [];
const assignments: Record<string, string[]> = { ...pending };
for (const botId of botIdsWithSkillState(DATA_DIR)) {
  const report = migrateBotSkillsToLibrary(botId);
  outcomes.push(...report.outcomes);
  if (report.assignments[botId]?.length) {
    assignments[botId] = [...new Set([...(assignments[botId] ?? []), ...report.assignments[botId]!])].sort();
  }
}
writePendingAssignments(assignments);
const applied = outcomes.filter((outcome) => outcome.outcome !== "skipped").length;
console.log(JSON.stringify({ dataDir: DATA_DIR, bots: Object.keys(assignments).length, applied, skipped: outcomes.length - applied, outcomes }, null, 2));
