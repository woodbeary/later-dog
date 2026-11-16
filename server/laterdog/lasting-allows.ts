import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { LastingOffer, LastingWhy } from "../../shared/lasting-allows.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { writeFileAtomic } from "../atomic.ts";

export const LASTING_ALLOW_LIST: ReadonlyArray<{ driver: string; tool: string }> = [{ driver: "claudeAgent", tool: "WebSearch" }];

const STORE_VERSION = 4;
const MAX_RULES_PER_BOT = 500;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const BOT_ID = /^[\w-]{1,128}$/;
const RULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RULE_FIELDS = ["id", "botId", "kind", "keySha256", "preview", "grantedAt", "grantedBy", "fromThreadId"];

export type LastingRequest = {
  driver: string | undefined;
  tool: string;
  wholeInput?: unknown;
  approvalScope?: string;
  alwaysAsks: boolean;
  ownerOnly: boolean;
  group?: boolean;
};

export type LastingVerdict = { offered: true; keySha256: string } | { offered: false; why: LastingWhy };

export type LastingRule = {
  id: string;
  botId: string;
  kind: "search";
  keySha256: string;
  preview: "Search";
  grantedAt: string;
  grantedBy: string;
  fromThreadId: string;
};

const TEAMMATE_TOOL = /(?:^|__)(?:ask_bot|delegate_bot|coordinate_bots|post_to_room)$/;
const SCREEN_TOOL = /(?:^|__)(?:computer|shared_computer)(?:__|$)|^mac_/;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function canonicalInput(input: unknown): string {
  return JSON.stringify(sorted(input));
}

function listed(driver: string | undefined, tool: string): boolean {
  return LASTING_ALLOW_LIST.some((entry) => entry.driver === driver && entry.tool === tool);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function lastingVerdict(request: LastingRequest): LastingVerdict {
  if (request.alwaysAsks) return { offered: false, why: "always-asks" };
  if (request.group) return { offered: false, why: "group" };
  if (!request.ownerOnly) return { offered: false, why: "owner-only" };
  const whole = plainObject(request.wholeInput) ? canonicalInput(request.wholeInput) : undefined;
  if (whole !== undefined && redactSecretsInText(whole) !== whole) return { offered: false, why: "secret" };
  if (!LASTING_ALLOW_LIST.some((entry) => entry.driver === request.driver)) return { offered: false, why: "incomplete" };
  if (!listed(request.driver, request.tool)) {
    if (request.approvalScope === "local-computer" || SCREEN_TOOL.test(request.tool)) return { offered: false, why: "screen" };
    if (TEAMMATE_TOOL.test(request.tool)) return { offered: false, why: "teammate" };
    return { offered: false, why: "state" };
  }
  if (whole === undefined) return { offered: false, why: "incomplete" };
  const keySha256 = createHash("sha256").update(canonicalInput({ driver: request.driver, tool: request.tool, input: request.wholeInput })).digest("hex");
  return { offered: true, keySha256 };
}

export type TurnLine = {
  role: string;
  at: number;
  peerAsk?: unknown;
  from?: { botId?: string };
  relayed?: boolean;
  webhookPost?: boolean;
  via?: string;
  sender?: { id?: string };
};

export function onlyOwnerReached(lines: readonly TurnLine[], startedAt: number | undefined, ownerPerson: (person: string | undefined) => boolean, asker: string): boolean {
  const start = startedAt ?? Number.POSITIVE_INFINITY;
  const lastReply = lines.findLastIndex((line) => line.role === "bot" && (line.from === undefined || line.from.botId === asker) && line.at < start);
  return lines.slice(lastReply + 1).every((line) => {
    if (line.from !== undefined && line.from.botId !== asker) return false;
    if (line.role !== "user") return true;
    return !line.peerAsk && !line.relayed && !line.webhookPost && line.via !== "api" && ownerPerson(line.sender?.id);
  });
}

export function lastingOffer(verdict: LastingVerdict, reach: string): LastingOffer {
  return verdict.offered ? { offered: true, reach } : { offered: false, why: verdict.why };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const refused = (message: string, status: number): Error => Object.assign(new Error(message), { status });

function validRule(row: unknown): row is LastingRule {
  return record(row) && Object.keys(row).every((key) => RULE_FIELDS.includes(key)) &&
    typeof row.id === "string" && RULE_ID.test(row.id) &&
    typeof row.botId === "string" && BOT_ID.test(row.botId) &&
    row.kind === "search" && row.preview === "Search" &&
    typeof row.keySha256 === "string" && SHA256.test(row.keySha256) &&
    typeof row.grantedAt === "string" && typeof row.grantedBy === "string" && typeof row.fromThreadId === "string";
}

export class LastingAllowStore {
  private rules: LastingRule[] = [];
  private paused = new Set<string>();
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error("Invalid lasting-allow store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== STORE_VERSION || !Array.isArray(saved.rules) || !Array.isArray(saved.paused) ||
        Object.keys(saved).some((key) => !["version", "rules", "paused"].includes(key))) throw new Error("Invalid lasting-allow store.");
      const ids = new Set<string>();
      for (const row of saved.rules) {
        if (!validRule(row) || ids.has(row.id)) throw new Error("Invalid lasting-allow store.");
        ids.add(row.id);
      }
      if (saved.paused.some((botId) => typeof botId !== "string" || !BOT_ID.test(botId))) throw new Error("Invalid lasting-allow store.");
      this.rules = saved.rules as LastingRule[];
      this.paused = new Set(saved.paused as string[]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  list(botId: string): LastingRule[] {
    return this.rules.filter((rule) => rule.botId === botId);
  }

  isUnreadable(): boolean {
    return this.unreadable;
  }

  isPaused(botId: string): boolean {
    return this.paused.has(botId);
  }

  answers(botId: string, keySha256: string): LastingRule | undefined {
    if (this.unreadable || this.paused.has(botId)) return undefined;
    return this.rules.find((rule) => rule.botId === botId && rule.keySha256 === keySha256);
  }

  grant(input: { botId: string; keySha256: string; grantedBy: string; fromThreadId: string }): LastingRule {
    this.assertWritable();
    if (!BOT_ID.test(input.botId) || !SHA256.test(input.keySha256)) throw refused("That grant is not valid.", 400);
    const existing = this.rules.find((rule) => rule.botId === input.botId && rule.keySha256 === input.keySha256);
    if (existing) return existing;
    if (this.list(input.botId).length >= MAX_RULES_PER_BOT) throw refused("A dog may hold at most 500 Always grants.", 409);
    const rule: LastingRule = {
      id: randomUUID(),
      botId: input.botId,
      kind: "search",
      keySha256: input.keySha256,
      preview: "Search",
      grantedAt: new Date().toISOString(),
      grantedBy: input.grantedBy,
      fromThreadId: input.fromThreadId,
    };
    this.save([...this.rules, rule], this.paused);
    return rule;
  }

  remove(botId: string, ruleId: string): boolean {
    this.assertWritable();
    const next = this.rules.filter((rule) => rule.botId !== botId || rule.id !== ruleId);
    if (next.length === this.rules.length) return false;
    this.save(next, this.paused);
    return true;
  }

  pause(botId: string): void {
    if (this.unreadable || this.paused.has(botId)) return;
    this.save(this.rules, new Set([...this.paused, botId]));
  }

  resume(botId: string): void {
    this.assertWritable();
    if (!this.paused.has(botId)) return;
    this.save(this.rules, new Set([...this.paused].filter((id) => id !== botId)));
  }

  clear(botId: string): void {
    if (this.unreadable) return;
    const next = this.rules.filter((rule) => rule.botId !== botId);
    if (next.length !== this.rules.length || this.paused.has(botId)) {
      this.save(next, new Set([...this.paused].filter((id) => id !== botId)));
    }
  }

  private assertWritable(): void {
    if (this.unreadable) throw refused("Always grants could not be read. Repair the store before changing them.", 503);
  }

  private save(rules: LastingRule[], paused: Set<string>): void {
    const json = JSON.stringify({ version: STORE_VERSION, rules, paused: [...paused] }, null, 2);
    if (Buffer.byteLength(json) > MAX_STORE_BYTES) throw refused("Always grants exceed the storage limit.", 409);
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.rules = rules;
    this.paused = paused;
  }
}
