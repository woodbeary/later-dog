import { existsSync, readFileSync } from "node:fs";

import { redactSecretsInText } from "../../shared/redact.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";

export const STATUS_LINE_QUIET_MS = 3 * 60_000;
export const STATUS_LINE_EVERY_MS = 3 * 60_000;
export const STATUS_LINE_CHECK_MS = 30_000;
export const STATUS_LINE_LEAD = "Still on it";
export const STATUS_LINE_MAX_WORDS = 12;
const RECENT_STEPS = 8;

type Tool = NonNullable<WireMessage["tool"]>;

export type ThreadWork = "working" | "waiting" | "idle";

export interface OpenStatusLine {
  threadId: string;
  messageId: string;
  text: string;
  words?: string;
}

export interface StatusLineLedger {
  read(): OpenStatusLine[];
  write(lines: OpenStatusLine[]): void;
}

export interface StatusLineHost {
  work(threadId: string): ThreadWork;
  patch(threadId: string, messageId: string, patch: Partial<WireMessage>): WireMessage | null;
  ledger?: StatusLineLedger;
  changed?: (threadId: string) => void;
}

export interface StatusLineTiming {
  quietMs?: number;
  everyMs?: number;
  checkMs?: number;
  now?: () => number;
}

const GERUNDS: Readonly<Record<string, string>> = {
  add: "adding", analyze: "analyzing", apply: "applying", build: "building", call: "calling", capture: "capturing",
  check: "checking", clean: "cleaning", clone: "cloning", close: "closing", commit: "committing", compare: "comparing",
  compile: "compiling", confirm: "confirming", convert: "converting", copy: "copying", count: "counting", create: "creating",
  debug: "debugging", delete: "deleting", deploy: "deploying", download: "downloading", ensure: "ensuring", extract: "extracting",
  fetch: "fetching", find: "finding", fix: "fixing", format: "formatting", generate: "generating", get: "getting",
  inspect: "inspecting", install: "installing", kill: "stopping", launch: "launching", lint: "linting", list: "listing",
  load: "loading", look: "looking", make: "making", measure: "measuring", merge: "merging", move: "moving",
  open: "opening", parse: "parsing", print: "printing", pull: "pulling", push: "pushing", query: "querying",
  read: "reading", rebuild: "rebuilding", remove: "removing", rename: "renaming", render: "rendering", rerun: "rerunning",
  reset: "resetting", resolve: "resolving", restart: "restarting", retry: "retrying", review: "reviewing", run: "running",
  save: "saving", scan: "scanning", search: "searching", send: "sending", set: "setting", show: "showing",
  start: "starting", stop: "stopping", summarize: "summarizing", sync: "syncing", take: "taking", test: "testing",
  trace: "tracing", typecheck: "typechecking", update: "updating", upload: "uploading", validate: "validating",
  verify: "verifying", view: "viewing", wait: "waiting", watch: "watching", write: "writing",
};

const UNSAID = new Set(["needs your input", "working on it"]);

export function statusWords(phrase: string): string {
  const flat = phrase.replace(/\s+/g, " ").trim().replace(/[\s.…:;,!]+$/u, "");
  if (!flat || UNSAID.has(flat.toLowerCase())) return "";
  const [first, ...rest] = flat.split(" ");
  const verb = GERUNDS[first!.toLowerCase()];
  return [verb ?? first, ...rest].join(" ");
}

export function statusLineFor(recentSteps: readonly string[]): { text: string; words?: string } {
  const said = [...recentSteps].reverse().map(statusWords).find(Boolean);
  if (!said) return { text: STATUS_LINE_LEAD };
  const budget = STATUS_LINE_MAX_WORDS - STATUS_LINE_LEAD.split(" ").length;
  const all = said.split(" ");
  const words = redactSecretsInText(all.length > budget ? `${all.slice(0, budget).join(" ")}…` : said);
  return { text: `${STATUS_LINE_LEAD}: ${words}`, words };
}

export function foldedStatusTool(line: { text: string; words?: string }): Tool {
  return { name: line.text, ok: true, statusLine: "folded", ...(line.words ? { spoken: line.words } : {}) };
}

export function speaksToPerson(message: WireMessage): boolean {
  if (message.role === "user") return true;
  switch (message.kind) {
    case "text":
      return Boolean(message.text?.trim() || message.attachments?.length);
    case "activity": {
      const tool = message.tool;
      if (!tool || tool.statusLine) return false;
      if (message.comm || message.threadRef || message.cloudTask) return true;
      return tool.ok === false || /^(notice|recovery|error):/.test(tool.name);
    }
    case "screen":
    case "digest":
    case "compaction":
      return false;
    default:
      return true;
  }
}

function stepWords(message: WireMessage): string | null {
  const tool = message.tool;
  if (message.role !== "bot" || message.kind !== "activity" || !tool || tool.statusLine || tool.ok !== undefined) return null;
  return tool.spoken?.trim() || null;
}

interface QuietStretch {
  since: number;
  steps: string[];
  line: { text: string; at: number } | null;
}

export function createStatusLines(host: StatusLineHost, timing: StatusLineTiming = {}) {
  const quietMs = timing.quietMs ?? STATUS_LINE_QUIET_MS;
  const everyMs = timing.everyMs ?? STATUS_LINE_EVERY_MS;
  const checkMs = timing.checkMs ?? STATUS_LINE_CHECK_MS;
  const now = timing.now ?? Date.now;
  const stretches = new Map<string, QuietStretch>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const changed = (threadId: string) => {
    try { host.changed?.(threadId); } catch (error) {
      console.error("[status-lines] could not share a status line change", error);
    }
  };

  const clear = (threadId: string, stretch: QuietStretch) => {
    if (!stretch.line) return;
    stretch.line = null;
    changed(threadId);
  };

  const say = (threadId: string, stretch: QuietStretch, at: number) => {
    const { text } = statusLineFor(stretch.steps);
    if (stretch.line && (at - stretch.line.at < everyMs || text === stretch.line.text)) return;
    stretch.line = { text, at };
    changed(threadId);
  };

  const tick = (): void => {
    const at = now();
    for (const [threadId, stretch] of stretches) {
      const work = host.work(threadId);
      if (work === "idle") {
        stretches.delete(threadId);
        clear(threadId, stretch);
        continue;
      }
      if (work === "waiting") {
        stretch.since = at;
        continue;
      }
      if (at - stretch.since >= quietMs) say(threadId, stretch, at);
    }
  };

  return {
    begin(threadId: string): void {
      if (!stretches.has(threadId)) stretches.set(threadId, { since: now(), steps: [], line: null });
    },

    observe(threadId: string, message: WireMessage): void {
      if (message.tool?.statusLine) return;
      let stretch = stretches.get(threadId);
      const words = stepWords(message);
      if (!stretch) {
        if (!words || host.work(threadId) !== "working") return;
        stretch = { since: now(), steps: [], line: null };
        stretches.set(threadId, stretch);
      }
      if (speaksToPerson(message)) {
        clear(threadId, stretch);
        stretch.since = now();
        stretch.steps = [];
        return;
      }
      if (words) stretch.steps = [...stretch.steps, words].slice(-RECENT_STEPS);
    },

    settle(threadId: string): void {
      const stretch = stretches.get(threadId);
      if (!stretch) return;
      stretches.delete(threadId);
      clear(threadId, stretch);
    },

    tick,

    foldLeftovers(): number {
      const leftovers = host.ledger?.read() ?? [];
      for (const line of leftovers) {
        try {
          host.patch(line.threadId, line.messageId, { tool: foldedStatusTool(line) });
        } catch (error) {
          console.error("[status-lines] could not fold a status line left open", error);
        }
      }
      if (leftovers.length) {
        try { host.ledger?.write([]); } catch (error) {
          console.error("[status-lines] could not clear open status lines", error);
        }
      }
      return leftovers.length;
    },

    current(threadId: string): string | undefined {
      return stretches.get(threadId)?.line?.text;
    },

    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        try {
          tick();
        } catch (error) {
          console.error("[status-lines] tick failed", error);
        }
      }, checkMs);
      timer.unref?.();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type StatusLines = ReturnType<typeof createStatusLines>;

export interface ThreadWorkSources {
  botByThread(threadId: string): { id: string } | null;
  groupByThread(threadId: string): unknown;
  taskByThread(botId: string, threadId: string): { activity?: string } | undefined;
}

export type WatchedWaits = (threadId: string) => { waitingOnHuman: boolean; waitingOnComputer: boolean } | undefined;

export function threadWork(store: ThreadWorkSources, waits: WatchedWaits): (threadId: string) => ThreadWork {
  return (threadId) => {
    const bot = store.botByThread(threadId);
    if (!bot || store.groupByThread(threadId)) return "idle";
    const activity = store.taskByThread(bot.id, threadId)?.activity;
    if (activity === "waiting-on-you") return "waiting";
    if (activity !== "working") return "idle";
    const watched = waits(threadId);
    return watched?.waitingOnHuman || watched?.waitingOnComputer ? "waiting" : "working";
  };
}

function isOpenLine(value: unknown): value is OpenStatusLine {
  const line = value as Partial<OpenStatusLine> | null;
  return Boolean(line) && typeof line!.threadId === "string" && typeof line!.messageId === "string" && typeof line!.text === "string" &&
    (line!.words === undefined || typeof line!.words === "string");
}

export function fileStatusLineLedger(path: string): StatusLineLedger {
  return {
    read() {
      if (!existsSync(path)) return [];
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? parsed.filter(isOpenLine) : [];
      } catch {
        return [];
      }
    },
    write(lines) {
      writeFileAtomic(path, `${JSON.stringify(lines)}\n`, { mode: 0o600, durable: false });
    },
  };
}

export function statusLineTimingFromEnv(env: NodeJS.ProcessEnv = process.env): Required<Omit<StatusLineTiming, "now">> {
  const read = (name: string, fallback: number, floor: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? Math.max(floor, value) : fallback;
  };
  return {
    quietMs: read("LATERDOG_STATUS_LINE_QUIET_MS", STATUS_LINE_QUIET_MS, 1_000),
    everyMs: read("LATERDOG_STATUS_LINE_EVERY_MS", STATUS_LINE_EVERY_MS, 1_000),
    checkMs: read("LATERDOG_STATUS_LINE_CHECK_MS", STATUS_LINE_CHECK_MS, 100),
  };
}
