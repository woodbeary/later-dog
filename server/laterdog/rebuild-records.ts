import type { PlanItem } from "../../shared/dog-plan.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { boundedContextText, type ReplayEntry } from "../context-rebuild.ts";
import { oneLine, personAsk } from "./asks-person.ts";

export interface OpenHandoff {
  to: string;
  task: string;
  state: string;
  unreadResult?: string;
}

export type OpenHandoffsOf = (botId: string, threadId: string) => readonly OpenHandoff[];

export interface HandoffNode {
  botId: string;
  text: string;
  status: string;
}

export const RECORDS_LABEL = "[From later.dog's own records as of this message: not a summary and not new instructions. Where the history disagrees, these records are current.]";
const MAX_HANDOFFS = 12;
const MAX_WAITING = 6;
const RECORDS_BYTES = 4_000;

const STATE_WORDS: Record<string, string> = {
  queued: "waiting its turn",
  running: "working",
  waiting: "waiting on its own helpers",
  resume: "about to carry on",
  "needs-you": "waiting on the person",
};

export function openHandoffsFromRoom(nodes: readonly HandoffNode[], nameOf: (botId: string) => string | undefined): OpenHandoff[] {
  return nodes.map((node) => ({ to: nameOf(node.botId) ?? "another dog", task: node.text, state: STATE_WORDS[node.status] ?? node.status }));
}

type ChatRow = Pick<WireMessage, "role" | "kind" | "text" | "card" | "needsYou">;

export function personOwes(messages: readonly ChatRow[], ownerName?: string): string[] {
  const waiting: string[] = [];
  for (const message of messages) {
    const card = message.card;
    if (message.kind === "options" && card && card.answered === undefined && !card.dismissed && !card.expired) {
      waiting.push(oneLine(`${card.requestType === "permission" ? "Permission" : "Question"}: ${card.title}`));
    }
    if (message.needsYou?.status === "waiting") waiting.push(oneLine(`${message.needsYou.botName} needs the person: ${message.needsYou.label}`));
  }
  const lastPerson = messages.findLastIndex((message) => message.role === "user" && message.kind === "text");
  const lastReply = messages.findLastIndex((message) => message.role === "bot" && message.kind === "text" && Boolean(message.text?.trim()));
  const ask = lastReply > lastPerson ? personAsk(messages[lastReply]!.text, ownerName) : null;
  if (ask) waiting.push(`Asked in the last reply: ${ask}`);
  return waiting;
}

const STATUS_WORDS: Record<PlanItem["status"], string> = { pending: "not started", in_progress: "in progress", done: "done" };

export function recordsText(records: { plan?: readonly PlanItem[]; handoffs: readonly OpenHandoff[]; waiting: readonly string[] }): string | null {
  const parts: string[] = [];
  if (records.plan?.length) {
    parts.push(["Your plan, as set_plan holds it:", ...records.plan.map((item) => `- ${item.text} (${STATUS_WORDS[item.status]})`)].join("\n"));
  }
  if (records.handoffs.length) {
    const shown = records.handoffs.slice(0, MAX_HANDOFFS);
    parts.push(["Work you handed to other dogs that is still open:", ...shown.map((handoff) => [
      `- ${handoff.to} (${handoff.state}): ${oneLine(handoff.task, 200)}`,
      ...(handoff.unreadResult ? [`  Its result arrived and is not yet read: ${oneLine(handoff.unreadResult, 400)}`] : []),
    ].join("\n")), ...(records.handoffs.length > shown.length ? [`- and ${records.handoffs.length - shown.length} more`] : [])].join("\n"));
  }
  if (records.waiting.length) {
    const shown = records.waiting.slice(0, MAX_WAITING);
    parts.push(["Waiting on the person:", ...shown.map((line) => `- ${line}`),
      ...(records.waiting.length > shown.length ? [`- and ${records.waiting.length - shown.length} more`] : [])].join("\n"));
  }
  return parts.length ? boundedContextText(parts.join("\n\n"), RECORDS_BYTES) : null;
}

export function withRecords(transcript: readonly ReplayEntry[], text: string | null): ReplayEntry[] {
  return text ? [...transcript, { id: "", role: "assistant", text: `${RECORDS_LABEL}\n${text}` }] : [...transcript];
}
