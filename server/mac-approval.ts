import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { MAC_ALLOW_KEY } from "../shared/cloud-home.ts";
import { writeFileAtomic } from "./atomic.ts";
import { newId } from "./contracts.ts";
import { buildNotification, type Notification } from "./notify.ts";
import type { BotRecord, Store } from "./store.ts";

export type MacMode = "ask" | "always" | "never";
export type MacTool = "mac_list_files" | "mac_read_file" | "mac_write_file" | "mac_run_command" | "mac_computer_call";
export type MacAccess = { mode: MacMode; dogs: string[] };
export type MacVerdict = { ok: true } | { ok: false; status: number; error: string };
export { MAC_ALLOW_KEY };
type MacKind = "look" | "save" | "command" | "apps";

export const MAC_CARD_MS = 210_000;
export const MAC_NEVER = "The person set their Mac to Never in Settings, so you can't use it. Tell them in one line and don't retry.";
export const MAC_DENIED = "The person didn't allow it, so this didn't happen. Tell them in one line and don't retry unless they ask again.";
export const MAC_EXPIRED = "The person didn't answer the card about their Mac in time, so this didn't happen. Tell them in one line; they can ask again.";
export const MAC_CANCELLED = "The request to use the person's Mac was cancelled, so this didn't happen.";
const TURN_ENDED = "The requesting turn ended";

const TOOLS: Record<string, MacTool> = {
  list_files: "mac_list_files",
  read_file: "mac_read_file",
  write_file: "mac_write_file",
  run_command: "mac_run_command",
  computer_call: "mac_computer_call",
};
const KINDS: Record<MacTool, MacKind> = {
  mac_list_files: "look",
  mac_read_file: "look",
  mac_write_file: "save",
  mac_run_command: "command",
  mac_computer_call: "apps",
};
export const MAC_WORDS: Record<MacTool, string> = {
  mac_list_files: "look in a folder on your Mac",
  mac_read_file: "open a file on your Mac",
  mac_write_file: "save a file on your Mac",
  mac_run_command: "run a command on your Mac",
  mac_computer_call: "use apps on your Mac",
};

const ALLOWED: MacVerdict = { ok: true };
const settingsFile = z.object({
  version: z.literal(1),
  mode: z.enum(["ask", "always", "never"]),
  dogs: z.array(z.string().min(1).max(128)).max(500),
}).strict();

export function macTool(action: string): MacTool | null {
  return Object.hasOwn(TOOLS, action) ? TOOLS[action]! : null;
}

export function isMacTool(tool: string | undefined): tool is MacTool {
  return tool !== undefined && Object.hasOwn(KINDS, tool);
}

type MacOperation = { action: string; path?: string; command?: string; tool_name?: string; arguments?: Record<string, unknown> };

export function macDetail(operation: MacOperation): string {
  const text = operation.action === "run_command" ? (operation.command ?? "").trim()
    : operation.action === "computer_call" ? appLabel(operation)
      : macPathLabel(operation.path);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function macPathLabel(path: string | undefined): string {
  const text = (path ?? "").trim();
  if (text.startsWith("/")) return text.replace(/\/+$/, "") || "/";
  const relative = text.replace(/^~(?=\/|$)/, "").replace(/^(?:\.?\/+)+/, "").replace(/\/+$/, "");
  return relative && relative !== "." ? `~/${relative}` : "~";
}

function appLabel(operation: MacOperation): string {
  if (operation.tool_name !== "launch_app") return "";
  const name = operation.arguments?.name ?? operation.arguments?.bundle_id;
  return typeof name === "string" ? name.trim() : "";
}

interface Waiter { resolve: (verdict: MacVerdict) => void; active: () => boolean }
interface OpenCard {
  requestId: string;
  messageId: string;
  threadId: string;
  botId: string;
  requestMessageId: string | undefined;
  kind: MacKind;
  waiters: Set<Waiter>;
  timer: ReturnType<typeof setTimeout>;
}

export interface MacApprovalDeps {
  store: Store;
  notify: (notification: Notification | null) => void;
  file: string;
  cardMs?: number;
  sweepMs?: number;
}

export interface MacCheck {
  bot: BotRecord;
  threadId: string;
  computer: string;
  operation: MacOperation;
  requestMessageId?: string;
  active: () => boolean;
}

export class MacApprovals {
  private readonly deps: MacApprovalDeps;
  private access: MacAccess;
  private readonly open = new Map<string, OpenCard>();
  private readonly grants = new Map<string, { messageId: string | undefined; kinds: Set<MacKind> }>();
  private readonly allowedAlways = new Set<string>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(deps: MacApprovalDeps) {
    this.deps = deps;
    this.access = this.load();
  }

  settings(): MacAccess {
    return { mode: this.access.mode, dogs: [...this.access.dogs] };
  }

  update(input: { mode?: MacMode; dogs?: string[] }): MacAccess {
    const dogs = input.dogs === undefined ? this.access.dogs : [...new Set(input.dogs)].filter((id) => this.access.dogs.includes(id));
    this.access = { mode: input.mode ?? this.access.mode, dogs };
    this.save();
    if (this.access.mode !== "ask") {
      const verdict: MacVerdict = this.access.mode === "always" ? ALLOWED : { ok: false, status: 403, error: MAC_NEVER };
      for (const card of this.open.values()) this.settle(card, { answered: "unavailable", dismissed: true }, verdict);
    }
    return this.settings();
  }

  allowAlways(botId: string): void {
    if (!this.access.dogs.includes(botId)) {
      this.access = { ...this.access, dogs: [...this.access.dogs, botId].slice(-500) };
      this.save();
    }
    for (const card of this.open.values()) {
      if (card.botId !== botId) continue;
      this.allowedAlways.add(card.requestId);
      this.settle(card, { answered: "allow" }, ALLOWED);
    }
    for (const requestId of [...this.allowedAlways].slice(0, -100)) this.allowedAlways.delete(requestId);
  }

  forgetDog(botId: string): void {
    if (this.access.dogs.includes(botId)) {
      this.access = { ...this.access, dogs: this.access.dogs.filter((id) => id !== botId) };
      this.save();
    }
    for (const card of this.open.values()) if (card.botId === botId) this.cancel(card);
    for (const key of this.grants.keys()) if (key.endsWith(`\n${botId}`)) this.grants.delete(key);
  }

  pending(threadId: string, botId?: string): boolean {
    return [...this.open.values()].some((card) => card.threadId === threadId && (botId === undefined || card.botId === botId));
  }

  async check(input: MacCheck): Promise<MacVerdict> {
    const tool = macTool(input.operation.action);
    if (!tool) return ALLOWED;
    if (this.access.mode === "never") return { ok: false, status: 403, error: MAC_NEVER };
    if (this.access.mode === "always" || this.access.dogs.includes(input.bot.id)) return ALLOWED;
    const kind = KINDS[tool];
    const requestMessageId = input.requestMessageId ?? this.latestPerson(input.threadId);
    const grant = this.grants.get(grantKey(input.threadId, input.bot.id));
    if (grant && grant.kinds.has(kind) && grant.messageId === requestMessageId) return ALLOWED;
    if (!input.active()) return { ok: false, status: 401, error: TURN_ENDED };
    const card = [...this.open.values()].find((candidate) =>
      candidate.threadId === input.threadId && candidate.botId === input.bot.id && candidate.kind === kind && candidate.requestMessageId === requestMessageId)
      ?? this.openCard(input, tool, kind, requestMessageId);
    return await new Promise<MacVerdict>((resolve) => {
      card.waiters.add({ resolve, active: input.active });
      this.sweep(true);
    });
  }

  resolve(requestId: string, behavior: string | undefined): boolean {
    const card = this.open.get(requestId);
    if (!card) return this.allowedAlways.delete(requestId);
    const allow = behavior === "allow";
    if (allow) {
      const key = grantKey(card.threadId, card.botId);
      const messageId = card.requestMessageId;
      const current = this.grants.get(key);
      const kinds = current && current.messageId === messageId ? current.kinds : new Set<MacKind>();
      kinds.add(card.kind);
      this.grants.set(key, { messageId, kinds });
    }
    this.settle(card, { answered: allow ? "allow" : "deny" }, allow ? ALLOWED : { ok: false, status: 403, error: MAC_DENIED });
    return true;
  }

  cancelThread(threadId: string): void {
    for (const card of this.open.values()) if (card.threadId === threadId) this.cancel(card);
  }

  dismissStale(threadIds: Iterable<string>): number {
    let dismissed = 0;
    const store = this.deps.store;
    for (const threadId of threadIds) {
      for (const message of store.messagesFor(threadId)) {
        const card = message.card;
        if (!card?.requestId || card.answered || card.dismissed || !isMacTool(card.tool) || this.open.has(card.requestId)) continue;
        if (store.patchMessage(threadId, message.id, { card: { ...card, answered: "unavailable", expired: true } })) dismissed += 1;
      }
    }
    return dismissed;
  }

  close(): void {
    for (const card of this.open.values()) this.cancel(card);
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private openCard(input: MacCheck, tool: MacTool, kind: MacKind, requestMessageId: string | undefined): OpenCard {
    const { store } = this.deps;
    const { bot, threadId } = input;
    const requestId = newId();
    const room = store.groupByThread(threadId);
    const groupChat = Boolean(room && !room.dm);
    const subtitle = macDetail(input.operation);
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "options",
      ...(room ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
      ...(input.requestMessageId ? { requestMessageId: input.requestMessageId } : {}),
      card: {
        title: input.computer,
        subtitle,
        options: groupChat ? ["Allow", "Deny"] : ["Allow", "Deny", "Always allow"],
        requestId,
        tool,
        approvalScope: "local-computer",
        ...(groupChat ? {} : { allowKey: MAC_ALLOW_KEY }),
      },
    });
    const card: OpenCard = {
      requestId, messageId: message.id, threadId, botId: bot.id, requestMessageId, kind, waiters: new Set(),
      timer: setTimeout(() => {
        const open = this.open.get(requestId);
        if (open) this.settle(open, { answered: "unavailable", expired: true }, { ok: false, status: 408, error: MAC_EXPIRED });
      }, this.deps.cardMs ?? MAC_CARD_MS),
    };
    card.timer.unref?.();
    this.open.set(requestId, card);
    const task = store.projectBotForTask(bot.id, threadId);
    if (task) {
      if (task.busy) store.setTaskActivity(bot.id, threadId, "waiting-on-you");
    } else if (room && store.bot(bot.id)?.busy) {
      store.setActivity(bot.id, "waiting-on-you");
    }
    const detail = `Wants to ${MAC_WORDS[tool]}${subtitle ? `: ${subtitle}` : ""}`;
    this.deps.notify(buildNotification("approval", bot, threadId, detail, {
      avatarUrl: bot.avatarUrl,
      group: room && !room.dm ? { id: room.id, name: room.name } : undefined,
      card: { requestId, threadId },
    }));
    return card;
  }

  private cancel(card: OpenCard): void {
    this.settle(card, { answered: "unavailable", dismissed: true }, { ok: false, status: 409, error: MAC_CANCELLED });
  }

  private settle(card: OpenCard, patch: { answered: string; expired?: true; dismissed?: true }, verdict: MacVerdict): void {
    const { store } = this.deps;
    this.open.delete(card.requestId);
    clearTimeout(card.timer);
    const existing = store.messagesFor(card.threadId).find((message) => message.id === card.messageId);
    if (existing?.card && !existing.card.answered && !existing.card.dismissed) {
      store.patchMessage(card.threadId, card.messageId, { card: { ...existing.card, ...patch } });
    }
    if (!this.pending(card.threadId, card.botId)) {
      const task = store.projectBotForTask(card.botId, card.threadId);
      if (task) {
        if (task.activity === "waiting-on-you") store.setTaskActivity(card.botId, card.threadId, task.busy ? "working" : "idle");
      } else if (store.groupByThread(card.threadId)) {
        const waiting = store.bot(card.botId);
        if (waiting?.activity === "waiting-on-you") store.setActivity(waiting.id, waiting.busy ? "working" : "idle");
      }
    }
    for (const waiter of card.waiters) waiter.resolve(verdict);
    card.waiters.clear();
    this.sweep(false);
  }

  private sweep(start: boolean): void {
    if (this.open.size === 0) {
      if (this.sweeper) clearInterval(this.sweeper);
      this.sweeper = null;
      return;
    }
    if (!start || this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const card of this.open.values()) {
        for (const waiter of card.waiters) {
          if (waiter.active()) continue;
          card.waiters.delete(waiter);
          waiter.resolve({ ok: false, status: 401, error: TURN_ENDED });
        }
        if (card.waiters.size === 0) this.cancel(card);
      }
      this.sweep(false);
    }, this.deps.sweepMs ?? 2_000);
    this.sweeper.unref?.();
  }

  private latestPerson(threadId: string): string | undefined {
    return this.deps.store.activePath(threadId).findLast((message) => message.role === "user" && !message.peerAsk)?.id;
  }

  private load(): MacAccess {
    try {
      if (existsSync(this.deps.file)) {
        const stat = lstatSync(this.deps.file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 100_000) {
          const parsed = settingsFile.parse(JSON.parse(readFileSync(this.deps.file, "utf8")));
          return { mode: parsed.mode, dogs: parsed.dogs };
        }
      }
    } catch (error) {
      console.warn(`mac access: could not read settings: ${(error as Error).message}`);
    }
    return { mode: "ask", dogs: [] };
  }

  private save(): void {
    writeFileAtomic(this.deps.file, JSON.stringify({ version: 1, mode: this.access.mode, dogs: this.access.dogs }), { mode: 0o600 });
  }
}

function grantKey(threadId: string, botId: string): string {
  return `${threadId}\n${botId}`;
}
