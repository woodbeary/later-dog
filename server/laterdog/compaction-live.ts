import { redactSecretsInText } from "../../shared/redact.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { computerWaitDuration } from "../computer-wait.ts";
import { fileListLedger, type ListLedger } from "./list-ledger.ts";

export const COMPACTING_LINE = "Compacting the conversation";
const ERROR_CHARS = 2_000;

export type CompactionTrigger = "auto" | "manual";
export type CompactionStatus = "open" | "done" | "failed" | "skipped" | "stopped";

type Tool = NonNullable<WireMessage["tool"]>;

export interface CompactionStart {
  turnId?: string;
  trigger?: CompactionTrigger;
  stream?: boolean;
}

export interface CompactionOutcome {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  trigger?: CompactionTrigger;
  preTokens?: number;
  postTokens?: number;
  digests?: number;
  turnId?: string;
  stream?: boolean;
}

export interface OpenCompaction {
  threadId: string;
  messageId: string;
  trigger?: CompactionTrigger;
}

export type CompactionLedger = ListLedger<OpenCompaction>;

export interface CompactionHost {
  append(threadId: string, message: Omit<WireMessage, "id" | "at">): WireMessage | null;
  patch(threadId: string, messageId: string, patch: Partial<WireMessage>): unknown;
  ledger?: CompactionLedger;
  changed?: (threadId: string) => void;
  now?: () => number;
}

export interface CompactionFacts {
  status: CompactionStatus;
  trigger?: CompactionTrigger;
  tookMs?: number;
  error?: string;
  preTokens?: number;
  postTokens?: number;
  digests?: number;
}

interface Compaction extends CompactionFacts {
  messageId: string;
  turnId?: string;
  startedAt: number;
}

const tokens = (count: number) => `${count.toLocaleString("en-US")} token${count === 1 ? "" : "s"}`;

function compactionWords(facts: CompactionFacts): string {
  switch (facts.status) {
    case "open":
      return COMPACTING_LINE;
    case "done":
      return `Compacted the conversation${facts.tookMs === undefined ? "" : ` in ${computerWaitDuration(facts.tookMs)}`}`;
    case "failed":
      return "Couldn't compact the conversation";
    case "skipped":
      return "Skipped compacting the conversation";
    case "stopped":
      return "Stopped compacting the conversation";
  }
}

export function compactionTool(facts: CompactionFacts): Tool {
  const name = `context compaction (${facts.trigger ?? "auto"})`;
  const words = compactionWords(facts);
  if (facts.status === "open") return { name, spoken: words, compaction: true };
  const output = [
    ...(facts.status === "failed" && facts.error ? [facts.error] : []),
    ...(facts.preTokens === undefined ? [] : [`Before: ${tokens(facts.preTokens)}`]),
    ...(facts.postTokens === undefined ? [] : [`After: ${tokens(facts.postTokens)}`]),
    ...(facts.digests ? [`Re-sent the last ${facts.digests} digest${facts.digests === 1 ? "" : "s"}`] : []),
  ];
  return {
    name,
    ok: facts.status === "done" || facts.status === "skipped",
    spoken: words,
    summary: words,
    compaction: true,
    ...(output.length ? { output: output.join("\n") } : {}),
  };
}

const sameTurn = (a: string | undefined, b: string | undefined) => a === undefined || b === undefined || a === b;

function absorb(known: CompactionFacts, outcome: CompactionOutcome): void {
  if (outcome.trigger) known.trigger = outcome.trigger;
  if (outcome.preTokens !== undefined) known.preTokens = outcome.preTokens;
  if (outcome.postTokens !== undefined) known.postTokens = outcome.postTokens;
  if (outcome.digests !== undefined) known.digests = outcome.digests;
  const error = redactSecretsInText(outcome.error ?? "").replace(/\s+/g, " ").trim();
  if (error) known.error = error.length > ERROR_CHARS ? `${error.slice(0, ERROR_CHARS)}…` : error;
}

const facts = ({ messageId: _messageId, turnId: _turnId, startedAt: _startedAt, ...rest }: Compaction): CompactionFacts => rest;

export function createCompactionLive(host: CompactionHost) {
  const now = host.now ?? Date.now;
  const latest = new Map<string, Compaction>();
  const streaming = new Set<string>();

  const changed = (threadId: string) => {
    try { host.changed?.(threadId); } catch (error) {
      console.error("[compaction-live] could not share a compaction change", error);
    }
  };

  const remember = () => {
    if (!host.ledger) return;
    const open = [...latest]
      .filter(([, compaction]) => compaction.status === "open")
      .map(([threadId, compaction]): OpenCompaction => ({
        threadId, messageId: compaction.messageId, ...(compaction.trigger ? { trigger: compaction.trigger } : {}),
      }));
    try { host.ledger.write(open); } catch (error) {
      console.error("[compaction-live] could not save the open compactions", error);
    }
  };

  const show = (threadId: string, compaction: Compaction) => {
    try { host.patch(threadId, compaction.messageId, { tool: compactionTool(facts(compaction)) }); } catch (error) {
      console.error("[compaction-live] could not update a compaction row", error);
    }
  };

  const add = (threadId: string, compaction: Omit<Compaction, "messageId">): Compaction | null => {
    let row: WireMessage | null = null;
    try {
      row = host.append(threadId, {
        role: "bot", kind: "activity",
        ...(compaction.turnId ? { turnId: compaction.turnId } : {}),
        tool: compactionTool(facts({ ...compaction, messageId: "" })),
      });
    } catch (error) {
      console.error("[compaction-live] could not add a compaction row", error);
    }
    if (!row) return null;
    const added = { ...compaction, messageId: row.id };
    latest.set(threadId, added);
    return added;
  };

  const close = (threadId: string, compaction: Compaction, status: Exclude<CompactionStatus, "open">) => {
    compaction.status = status;
    compaction.tookMs = Math.max(0, now() - compaction.startedAt);
    show(threadId, compaction);
    remember();
    changed(threadId);
  };

  return {
    started(threadId: string, start: CompactionStart = {}): void {
      if (start.stream) {
        if (streaming.has(threadId)) return;
        streaming.add(threadId);
      }
      const open = latest.get(threadId);
      if (open?.status === "open") {
        if (start.trigger && start.trigger !== open.trigger) {
          open.trigger = start.trigger;
          show(threadId, open);
          remember();
        }
        return;
      }
      if (!add(threadId, { status: "open", startedAt: now(), ...(start.turnId ? { turnId: start.turnId } : {}), ...(start.trigger ? { trigger: start.trigger } : {}) })) return;
      remember();
      changed(threadId);
    },

    finished(threadId: string, outcome: CompactionOutcome): void {
      if (outcome.stream) streaming.delete(threadId);
      const last = latest.get(threadId);
      if (last?.status === "open") {
        absorb(last, outcome);
        close(threadId, last, outcome.skipped ? "skipped" : outcome.ok ? "done" : "failed");
        return;
      }
      if (last && sameTurn(last.turnId, outcome.turnId)) {
        const before = JSON.stringify(compactionTool(facts(last)));
        absorb(last, outcome);
        if (!outcome.ok && !outcome.skipped) last.status = "failed";
        else if (last.status === "skipped" && !outcome.skipped) last.status = "done";
        if (JSON.stringify(compactionTool(facts(last))) !== before) show(threadId, last);
        return;
      }
      if (outcome.skipped) return;
      const closed: Omit<Compaction, "messageId"> = { status: outcome.ok ? "done" : "failed", startedAt: now(), ...(outcome.turnId ? { turnId: outcome.turnId } : {}) };
      absorb(closed, outcome);
      add(threadId, closed);
    },

    settle(threadId: string): void {
      streaming.delete(threadId);
      const last = latest.get(threadId);
      latest.delete(threadId);
      if (last?.status === "open") close(threadId, last, "stopped");
    },

    current(threadId: string): string | undefined {
      return latest.get(threadId)?.status === "open" ? COMPACTING_LINE : undefined;
    },

    foldLeftovers(): number {
      let leftovers: OpenCompaction[] = [];
      try { leftovers = host.ledger?.read() ?? []; } catch (error) {
        console.error("[compaction-live] could not read the compactions left open", error);
      }
      for (const open of leftovers) {
        try {
          host.patch(open.threadId, open.messageId, { tool: compactionTool({ status: "stopped", ...(open.trigger ? { trigger: open.trigger } : {}) }) });
        } catch (error) {
          console.error("[compaction-live] could not close a compaction left open", error);
        }
      }
      if (leftovers.length) {
        try { host.ledger?.write([]); } catch (error) {
          console.error("[compaction-live] could not clear the open compactions", error);
        }
      }
      return leftovers.length;
    },
  };
}

export type CompactionLive = ReturnType<typeof createCompactionLive>;

function isOpenCompaction(value: unknown): value is OpenCompaction {
  const open = value as Partial<OpenCompaction> | null;
  return Boolean(open) && typeof open!.threadId === "string" && typeof open!.messageId === "string" &&
    (open!.trigger === undefined || open!.trigger === "auto" || open!.trigger === "manual");
}

export function fileCompactionLedger(path: string): CompactionLedger {
  return fileListLedger(path, isOpenCompaction);
}
