import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeChainEntry {
  uuid: string;
  kind: "prompt" | "assistant" | "tool_use" | "tool_result";
  text: string;
}

export interface FakeChain {
  note(message: unknown): void;
  turn(prompt: string): void;
}

export type FakeChainOpening = { chain: FakeChain } | { refused: string };

const argAfter = (argv: readonly string[], flag: string) => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

function read(dir: string, session: string): FakeChainEntry[] | null {
  const file = join(dir, `${session}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as FakeChainEntry[]; } catch { return null; }
}

function describe(block: Record<string, unknown>): FakeChainEntry["kind"] | null {
  if (block.type === "text") return "assistant";
  if (block.type === "tool_use") return "tool_use";
  if (block.type === "tool_result") return "tool_result";
  return null;
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return block.text;
  if (block.type === "tool_use") return JSON.stringify({ name: block.name, input: block.input });
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  return "";
}

export function openFakeChain(env: NodeJS.ProcessEnv, argv: readonly string[], sessionId: string, uuid: () => string): FakeChainOpening | null {
  const dir = env.FAKE_CLAUDE_CHAIN_DIR;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const resumed = argAfter(argv, "--resume");
  const at = argAfter(argv, "--resume-session-at");
  const forking = argv.includes("--fork-session");
  let entries: FakeChainEntry[] = [];
  if (resumed) {
    const source = read(dir, resumed);
    if (!source) return { refused: `No conversation found with session ID: ${resumed}` };
    entries = source;
    if (at !== undefined) {
      const end = source.findLastIndex((entry) => entry.uuid === at);
      if (end === -1) return { refused: `No message found with message.uuid of: ${at}` };
      entries = source.slice(0, end + 1);
    }
  }
  if (env.FAKE_CLAUDE_FORK_LOG && resumed) {
    appendFileSync(env.FAKE_CLAUDE_FORK_LOG, `${JSON.stringify({ from: resumed, at: at ?? null, forked: forking, session: sessionId, kept: entries.length })}\n`);
  }
  const save = () => writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(entries));
  save();
  return {
    chain: {
      note(message) {
        if (!message || typeof message !== "object") return;
        const frame = message as Record<string, unknown>;
        if ((frame.type !== "assistant" && frame.type !== "user") || frame.parent_tool_use_id || frame.isReplay === true) return;
        const content = (frame.message as { content?: unknown } | undefined)?.content;
        const blocks = Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object") : [];
        const kinds = blocks.map((block) => ({ kind: describe(block), text: blockText(block) })).filter((entry) => entry.kind !== null);
        if (!kinds.length) return;
        const id = typeof frame.uuid === "string" ? frame.uuid : uuid();
        frame.uuid = id;
        for (const entry of kinds) entries.push({ uuid: id, kind: entry.kind!, text: entry.text });
        save();
      },
      turn(prompt) {
        if (env.FAKE_CLAUDE_SEEN_LOG) {
          appendFileSync(env.FAKE_CLAUDE_SEEN_LOG, `${JSON.stringify({ session: sessionId, prompt, history: entries.map(({ kind, text }) => ({ kind, text })) })}\n`);
        }
        entries.push({ uuid: uuid(), kind: "prompt", text: prompt });
        save();
      },
    },
  };
}
