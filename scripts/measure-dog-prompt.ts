import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Engine = "claude" | "codex";
type DogKind = "main" | "helpers" | "group" | "started";

export const DOG_KINDS: readonly DogKind[] = ["main", "helpers", "group", "started"];
export const ENGINES: readonly Engine[] = ["claude", "codex"];
export const ENGINE_MODELS: Readonly<Record<Engine, string>> = { claude: "claude-fable-5-2", codex: "gpt-5.6" };

export type Measured = { stableBytes: number; volatileBytes: number; firstNoteBytes: number; stableTokens: number; volatileTokens: number; totalTokens: number; resentNoteBytes?: number };
export type Measurement = Record<string, Measured>;

const SIMULATED_TURNS = 100;

const tokens = (bytes: number) => Math.ceil(bytes / 4);
const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

async function measure(dumpDir?: string): Promise<Measurement> {
  const home = mkdtempSync(join(tmpdir(), "laterdog-measure-"));
  process.env.LATERDOG_HOME = home;
  try {
    const sp = await import("../server/system-prompt.ts");
    const ws = await import("../server/workspace.ts");
    const surface = await import("../server/surface.ts");
    const work = await import("../server/laterdog/work-updates.ts");
    const recent = await import("../server/recent-work.ts");
    const peers = await import("../server/peer-roster.ts");
    const owner = await import("../server/laterdog/owner-auto.ts");
    const browser = await import("../server/browser-engine.ts");
    const crossRecall = await import("../server/laterdog/cross-dog-recall.ts");
    const google = await import("../server/laterdog/google.ts");
    const mainDog = await import("../server/laterdog/main-dog-prompt.ts");
    const skills = await import("../server/skills.ts");
    const room = await import("../server/laterdog/room-prompt.ts");
    const sections = await import("../server/laterdog/volatile-sections.ts");
    const guide = await import("../server/laterdog/dog-guidance.ts").catch(() => null);

    const dogId = "dog-scout";
    const dir = ws.workspaceDir(dogId);
    mkdirSync(join(dir, "memory"), { recursive: true });
    const memoryLine = (i: number) => `- Fact ${i}: Sam prefers short replies, keeps projects in one folder and checks the budget before paying for anything new.`;
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n" + Array.from({ length: 30 }, (_, i) => memoryLine(i)).join("\n") + "\n");
    for (const topic of ["deploys", "taxes", "garden"]) {
      writeFileSync(join(dir, "memory", topic + ".md"), `---\ntitle: ${topic}\ndescription: notes about ${topic}\n---\nbody`);
    }
    for (let i = 0; i < 12; i++) {
      const skillDir = join(dir, "skills", "skill-" + i);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: skill-${i}\ndescription: Does reusable task number ${i}, such as publishing a site or writing release notes.\n---\nBody`);
    }
    const now = Date.parse("2026-11-12T18:00:00Z");
    const recentAt = (said: string) => Array.from({ length: 6 }, (_, i) => ({
      threadId: "t" + i, at: now - (6 - i) * 60_000, where: i % 2 ? "group chat Ops" : "your chat", title: "Thread " + i,
      said: i === 5 ? said : "Finished the check and posted the summary for item " + i + " with the details you asked for.", private: false,
    }));
    const recentLines = recentAt("Finished the check and posted the summary for item 5 with the details you asked for.");
    const accounts = await import("../server/laterdog/account-usage.ts") as Record<string, unknown>;
    const handled = typeof accounts.USAGE_HANDLED_LINE === "string" ? accounts.USAGE_HANDLED_LINE : "";
    const legacyAccount = (main: boolean, left = 80) => handled && (main
      ? handled + ` This turn runs on the Claude plan account Sam (sam@example.com): session (5-hour) ${left}% left, weekly 60% left. account_usage shows every account; switch_account moves this chat to another.`
      : handled);
    const persona = (name: string) => `You are ${name}, a ${guide ? "dog" : "personal bot"} in later.dog. Role: Research dog. About: Finds things and reports back.`;
    const soul = "Keep answers short. Ask before spending money. ".repeat(6);
    const owned = "Sam";
    const memory = (readOnly: boolean) => ws.memorySystemPrompt(dogId, { managedWrites: true, fileTools: true, readOnly });
    const timeZone = "America/Los_Angeles";
    const today = sp.todayPrompt(timeZone, new Date(now));
    const credential = sp.CREDENTIAL_PROMPT + google.GOOGLE_PROMPT;
    const guideParts = (engine: Engine, main: boolean) => guide
      ? [{ id: "guide", label: "How to work", text: guide.dogGuidance({ engine, model: ENGINE_MODELS[engine], kit: { cloudHome: true, ownComputer: true, vault: true, github: true, google: main, mac: true } }) }]
      : [];
    const teammate = "\nDo the request below in this conversation with your own tools, model and permissions. For a question, answer it; do not turn it into a project. For work, check the actual files and run the checks asked for. Do not give up at the first refusal or error from a tool or system: check what is actually true and try another way. A no from the person stays a no. If one step truly needs something only the person or the dog that asked can give, name exactly that step and finish everything else. Use coordinate_bots only for subwork you truly need, then end your turn; results resume you. Report what you did and what is still unverified. " + owner.ownerCoordinationAuthority(owned);
    const teammateText = guide?.TEAMMATE_TASK_PROMPT ? `\n${guide.TEAMMATE_TASK_PROMPT} ${owner.ownerCoordinationAuthority(owned)}` : teammate;

    const direct = (engine: Engine, kind: Exclude<DogKind, "group">, left = 80, lines = recentLines) => {
      const main = kind === "main";
      const started = kind === "started";
      const computer = kind === "started" ? null : "box";
      return sp.buildSystemPrompt(persona(main ? "Scout" : kind === "helpers" ? "Builder" : "Runner"), soul, [
        ...guideParts(engine, main),
        { id: "user-profile", label: "About the user", text: sp.userProfileSystemPrompt({ aboutMe: "Sam runs a small online shop and is not a programmer.", askFirst: ["spending money"] }) },
        { id: "owner-grant", label: "Owner's standing grant", text: owner.ownerGrantPrompt(owned) },
        { id: "files", label: "File locations", text: ws.workspaceLocationsPrompt(dogId, join(dir, "chat"), undefined) },
        { id: "computer", label: "Computer", text: sp.computerPrompt(computer) },
        { id: "plan", label: "Surface", text: surface.surfacePrompt({ computer: computer ? "cloud" : null, browser: true }, { cloudHome: true }) },
        { id: "cloud-home", label: "My Cloud", text: sp.cloudHomePrompt(true) },
        { id: "today", label: "Today", text: today },
        { id: "account", label: "Account", text: legacyAccount(main, left) },
        { id: "composio", label: "Connected apps", text: sp.composioSystemPrompt(undefined) },
        { id: "browser", label: "Browser", text: browser.BUILT_IN_BROWSER_SYSTEM_PROMPT },
        { id: "coordination", label: "Team", text: ` ${mainDog.withMainDogRouting(main, peers.PEERS_PROMPT)}` },
        { id: "assignment", label: "Teammate task", text: started ? teammateText : "" },
        { id: "credential", label: "Credentials", text: credential },
        { id: "recall", label: "Recall", text: ws.SESSION_SEARCH_SYSTEM_PROMPT },
        { id: "cross-recall", label: "Other dogs' chats", text: crossRecall.CROSS_DOG_RECALL_PROMPT },
        { id: "routine", label: "Routines", text: sp.ROUTINE_PROMPT },
        { id: "profile", label: "Profile changes", text: sp.PROFILE_PROMPT },
        { id: "learn", label: "Skill authoring", text: sp.LEARN_PROMPT },
        { id: "updates", label: "Progress updates", text: work.workUpdatesPrompt({ background: true, react: true }) },
        { id: "recent", label: "Recent work", text: recent.recentWorkPrompt(lines, now) },
        { id: "memory", label: "Memory", text: memory(false) },
        { id: "skills", label: "Skills index", text: skills.skillsSystemPrompt(dogId) },
      ], owned);
    };

    const resent = (engine: Engine) => {
      let seen: string | null = null;
      let delivered: ReturnType<typeof sections.deliveredSections> | null = null;
      let total = 0;
      for (let turn = 0; turn < SIMULATED_TURNS; turn++) {
        const built = direct(engine, "main", 80 - Math.floor(turn / 3), recentAt(`Finished step ${Math.floor(turn / 10)}.`));
        if (engine === "claude") {
          const next = sections.claudeContextNote({ systemVolatile: built.volatile, systemVolatileSections: built.volatileSections }, seen);
          total += bytesOf(next.note);
          seen = next.seen;
        } else {
          total += bytesOf(sections.sectionNoteBody(sections.sectionUpdate(built.volatileSections, delivered)));
          delivered = sections.deliveredSections(built.volatileSections);
        }
      }
      return total;
    };

    const group = (engine: Engine) => {
      const identity = room.roomIdentityPrompt({ dogName: "Scout", title: "Research dog", description: "Finds things and reports back.", roomName: "Ops", roster: "Builder (Build dog), Runner (Errands)", personName: owned });
      const roomTeam = "\nTo get another dog's help, here or in another group chat, use coordinate_bots (list_bots has the ids) instead of a native helper, then end your turn; their results resume you. Plain @mentions are only for conversational replies in this room.";
      return sp.buildSystemPrompt(identity, soul, [
        ...guideParts(engine, false),
        { id: "user-profile", label: "About the user", text: sp.userProfileSystemPrompt({ aboutMe: "Sam runs a small online shop and is not a programmer.", askFirst: ["spending money"] }) },
        { id: "owner-grant", label: "Owner's standing grant", text: owner.ownerGrantPrompt(owned) },
        { id: "coordination", label: "Team", text: guide?.ROOM_TEAM_PROMPT ? `\n${guide.ROOM_TEAM_PROMPT}` : roomTeam },
        { id: "credential", label: "Credentials", text: `\n${sp.CREDENTIAL_PROMPT.trim()}` },
        { id: "routine", label: "Routines", text: `\n${sp.ROUTINE_PROMPT.trim()}` },
        { id: "profile", label: "Profile changes", text: `\n${sp.PROFILE_PROMPT.trim()}` },
        { id: "files", label: "File locations", text: ws.workspaceLocationsPrompt(dogId, join(dir, "chat"), undefined) },
        { id: "computer", label: "Computer", text: sp.computerPrompt("box") },
        { id: "plan", label: "Surface", text: surface.surfacePrompt({ computer: "cloud", browser: true }, { cloudHome: true }) },
        { id: "cloud-home", label: "My Cloud", text: sp.cloudHomePrompt(true) },
        { id: "today", label: "Today", text: today },
        { id: "account", label: "Account", text: legacyAccount(false) },
        { id: "browser", label: "Browser", text: browser.BUILT_IN_BROWSER_SYSTEM_PROMPT },
        { id: "recall", label: "Recall", text: ws.SESSION_SEARCH_SYSTEM_PROMPT },
        { id: "cross-recall", label: "Other dogs' chats", text: crossRecall.CROSS_DOG_RECALL_PROMPT },
        { id: "recent", label: "Recent work", text: recent.recentWorkPrompt(recentLines, now) },
        { id: "updates", label: "Progress updates", text: work.workUpdatesPrompt({ background: true, react: true }) },
        { id: "memory", label: "Memory", text: `\n${memory(false).trim()}` },
        { id: "skills", label: "Skills index", text: skills.skillsSystemPrompt(dogId) },
      ], owned);
    };

    const out: Measurement = {};
    for (const engine of ENGINES) {
      for (const kind of DOG_KINDS) {
        const built = kind === "group" ? group(engine) : direct(engine, kind);
        const firstNote = engine === "claude"
          ? sections.claudeContextNote({ systemVolatile: built.volatile, systemVolatileSections: built.volatileSections }, null).note
          : sections.sectionNoteBody(sections.sectionUpdate(built.volatileSections, null));
        const stableBytes = bytesOf(built.stable);
        const volatileBytes = bytesOf(built.volatile);
        const firstNoteBytes = bytesOf(firstNote);
        out[`${kind}/${engine}`] = {
          stableBytes, volatileBytes, firstNoteBytes,
          stableTokens: tokens(stableBytes), volatileTokens: tokens(firstNoteBytes), totalTokens: tokens(stableBytes + firstNoteBytes),
          ...(kind === "main" ? { resentNoteBytes: resent(engine) } : {}),
        };
        if (dumpDir) {
          mkdirSync(dumpDir, { recursive: true });
          writeFileSync(join(dumpDir, `${kind}-${engine}.stable.txt`), built.stable);
          writeFileSync(join(dumpDir, `${kind}-${engine}.first-note.txt`), firstNote);
          writeFileSync(join(dumpDir, `${kind}-${engine}.sections.json`), JSON.stringify(built.sections.map(({ id, bytes }) => ({ id, bytes })), null, 1));
        }
      }
    }
    return out;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function table(current: Measurement, baseline: Measurement | null): string {
  const rows = Object.entries(current).map(([key, now]) => {
    const before = baseline?.[key];
    const saved = before ? `${(100 * (1 - now.totalTokens / before.totalTokens)).toFixed(1)}%` : "";
    return [key, before ? `${before.stableBytes}+${before.firstNoteBytes} B ~${before.totalTokens} tok` : "", `${now.stableBytes}+${now.firstNoteBytes} B ~${now.totalTokens} tok`, saved].join(" | ");
  });
  const resends = Object.entries(current).filter(([, now]) => now.resentNoteBytes !== undefined).map(([key, now]) => {
    const before = baseline?.[key]?.resentNoteBytes;
    const after = now.resentNoteBytes ?? 0;
    return `${key} | ${before === undefined ? "" : `${before} B ~${tokens(before)} tok`} | ${after} B ~${tokens(after)} tok | ${before ? `${(100 * (1 - after / before)).toFixed(1)}%` : ""}`;
  });
  rows.push("", `context notes re-sent over ${SIMULATED_TURNS} turns (account tick every 3rd turn while one exists, new work every 10th) | before | now | saved`, ...resends);
  return ["dog/engine | before (stable + first note) | now (stable + first note) | saved", ...rows].join("\n");
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const baselinePath = flag("--baseline") ?? join(import.meta.dirname, "dog-prompt-baseline.json");
const current = await measure(flag("--dump"));
const saveTo = flag("--save");
if (saveTo) writeFileSync(saveTo, JSON.stringify(current, null, 1) + "\n");
let baseline: Measurement | null = null;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Measurement;
} catch {
  baseline = null;
}
console.log("Measured on an invented fixture home; tokens are estimated as bytes / 4.");
console.log(table(current, baseline));
