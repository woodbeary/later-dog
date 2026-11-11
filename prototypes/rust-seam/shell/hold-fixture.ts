import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer } from "../../../scripts/control-laterdog.ts";
import { fixtureApi } from "../../../scripts/testing/preview-fixture.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WELCOME_VERSION = 2;

interface Dog {
  id: string;
  name: string;
  threadId: string;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1]!;
}

function replies(): string[] {
  const table = ["| Step | Result | Time |", "|---|---|---|", "| Install | passed | 41 s |", "| Typecheck | passed | 18 s |", "| Tests | 1,884 passed | 3 min 12 s |", "| Export | one bundle, 5.9 MB | 58 s |"].join("\n");
  const code = ["```ts", "export function carryOn(waiting: readonly string[], after: string | undefined): readonly string[] {", "  if (after === undefined) return waiting;", "  const start = waiting.findIndex((path) => path > after);", "  return start <= 0 ? waiting : [...waiting.slice(start), ...waiting.slice(0, start)];", "}", "```"].join("\n");
  const prose = "The release checklist is done apart from the two items that need you. The signed build finished and passed its smoke tests on both window sizes, the update guide names the new group and the rollback target, and the pull request is merged. Nothing else changed in this pass, so the next step is yours.";
  const list = ["Here is where things stand:", "", "- **Build:** finished and signed, with the long dog names fitting their rows.", "- **Docs:** the update guide is merged and names the rollback target.", "- **Waiting on you:** approve the screenshots and confirm the pricing line before Friday.", "", "`pnpm verify` passed in 4 min 12 s."].join("\n");
  const shapes = [prose, list, `${prose}\n\n${code}`, `Results from this run:\n\n${table}\n\n${prose}`, "Done. Nothing else needed.", `${list}\n\n${code}\n\n${table}`];
  return Array.from({ length: 1200 }, (_, index) => `Answer ${index + 1}. ${shapes[index % shapes.length]}`);
}

async function main() {
  const staticDir = resolve(option("dist", join(ROOT, "dist")));
  if (!existsSync(join(staticDir, "index.html"))) throw new Error("build the renderer first: pnpm exec vite build");
  const longTurns = Number(option("long-turns", "120"));
  const otherDogs = Number(option("other-dogs", "5"));
  const otherTurns = Number(option("other-turns", "6"));
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-shell-fixture-"));
  const repliesFile = join(scratch, "replies.json");
  writeFileSync(repliesFile, JSON.stringify(replies()));
  const fixture = await launchVerificationServer({
    ...process.env,
    LATERDOG_TEST_STATIC_DIR: staticDir,
    FAKE_CLAUDE_REPLIES_FILE: repliesFile,
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-index"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
  });
  const api = fixtureApi(fixture.info.url);
  await api("PATCH", "/api/config", { language: "en", onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });
  const make = async (name: string): Promise<Dog> => {
    const created = (await api("POST", "/api/bots", { name })) as { bot: Dog };
    return { id: created.bot.id, name: created.bot.name, threadId: created.bot.threadId };
  };
  const settled = async (dog: Dog) => {
    for (;;) {
      const state = (await api("GET", "/api/bots")) as { bots: Array<{ id: string; busy?: boolean; activity?: string }> };
      if (!state.bots.some((bot) => bot.id === dog.id && (bot.busy || bot.activity === "working"))) return;
      await new Promise((done) => setTimeout(done, 60));
    }
  };
  const fill = async (dog: Dog, turns: number) => {
    for (let turn = 0; turn < turns; turn += 1) {
      await api("POST", `/api/bots/${dog.id}/messages`, { text: `Where does the release stand? (${dog.name}, ${turn + 1})`, threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") });
      await new Promise((done) => setTimeout(done, 40));
      await settled(dog);
    }
  };
  const long = await make("Marathon");
  const others: Dog[] = [];
  for (let index = 0; index < otherDogs; index += 1) others.push(await make(`Helper ${index + 1}`));
  await Promise.all([fill(long, longTurns), ...others.map((dog) => fill(dog, otherTurns))]);
  const timedOpens = Number(option("time-opens", "0"));
  const pageMs = async (query: string): Promise<number[]> => {
    const took: number[] = [];
    for (let pass = 0; pass < timedOpens; pass += 1) {
      const started = performance.now();
      await api("GET", `/api/threads/${long.threadId}/messages${query}`);
      took.push(performance.now() - started);
    }
    return took;
  };
  const opens = timedOpens > 0 ? { newest50Ms: await pageMs("?limit=50"), wholeChatMs: await pageMs("") } : undefined;
  process.stdout.write(`${JSON.stringify({ url: fixture.info.url, serverPid: fixture.info.pid, dataDir: fixture.info.dataDir, long, short: others[0], opens })}\n`);
  const stop = () => {
    void fixture.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

await main();
