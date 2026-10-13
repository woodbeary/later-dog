import type { Message } from "@/state/store";
import { formatElapsed } from "@/lib/working-time";
import { t } from "@/lib/i18n";
import { failedTurnCause } from "../../shared/failed-turn";
import { localDay } from "@/lib/transcript-derivations";
import { screenTouchingTool, toolSurfaceKind } from "../../shared/tool-surface";

export type ActivityTranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "run"; id: string; messages: Message[] };

export type TranscriptItem =
  | ActivityTranscriptItem
  | { kind: "turn"; id: string; turnId: string; label: string; messages: Message[] };

export function statusActivity(message: Message): { kind: "recovery" | "notice"; text: string } | null {
  const name = message.kind === "activity" ? message.tool?.name : undefined;
  if (name?.startsWith("recovery:")) return { kind: "recovery", text: name.slice("recovery:".length).trim() };
  if (name?.startsWith("notice:")) return { kind: "notice", text: name.slice("notice:".length).trim() };
  return null;
}

export function isRecoveryActivity(message: Message): boolean {
  return statusActivity(message)?.kind === "recovery";
}

export function isStatusActivity(message: Message): boolean {
  return statusActivity(message) !== null;
}

function foldable(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm || message.threadRef || message.cloudTask || isStatusActivity(message)) return false;
  if (tool.ok !== true) return false;
  return failedTurnCause(tool.name) === null;
}

type TurnFold = Extract<TranscriptItem, { kind: "turn" }>;

function turnStep(message: Message, turnId: string): boolean {
  if (message.role !== "bot" || (message.turnId && message.turnId !== turnId)) return false;
  if (message.kind === "text") return Boolean(message.attachments?.length);
  return message.kind !== "digest";
}

export type TranscriptPlan = {
  byAnchorId: Map<string, TurnFold>;
  hiddenIds: Set<string>;
};

export const UPDATE_GAP_MS = 60_000;

const QUIET_KINDS: ReadonlySet<Message["kind"]> = new Set(["activity", "digest", "screen"]);

function spoken(message: Message): message is Message & { turnId: string } {
  return message.role === "bot" && message.kind === "text" && Boolean(message.turnId) &&
    Boolean(message.text?.trim()) && !message.attachments?.length;
}

function screenCapture(message: Message, toolName: string | undefined): boolean {
  if (message.role !== "bot" || message.kind !== "text" || message.text?.trim() || !toolName) return false;
  const attachments = message.attachments ?? [];
  if (!attachments.length || attachments.some((attachment) => attachment.kind !== "image")) return false;
  return screenTouchingTool(toolName) || toolSurfaceKind(toolName) !== null;
}

function workedLabel(elapsed: number): string {
  return elapsed >= 1_000 ? t("chat.run.workedFor", { elapsed: formatElapsed(elapsed) }) : t("chat.run.worked");
}

export function planTranscript(
  messages: readonly Message[],
  { runningSince = null, quiet = false }: { runningSince?: number | null; quiet?: boolean } = {},
): TranscriptPlan {
  const firstIndex = new Map<string, number>();
  const terminals = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.turnId) return;
    if (!firstIndex.has(message.turnId)) firstIndex.set(message.turnId, index);
    if (message.role === "bot" && message.kind === "text" && message.turnTerminal) terminals.set(message.turnId, index);
  });
  const lastStep = new Map<string, number>();
  for (const [turnId, terminalIndex] of terminals) {
    const start = firstIndex.get(turnId) ?? 0;
    for (let index = terminalIndex - 1; index >= start; index -= 1) {
      if (turnStep(messages[index], turnId)) {
        lastStep.set(turnId, index);
        break;
      }
    }
  }

  const hiddenIds = new Set<string>();
  const folded = new Map<string, Message[]>();
  const spokenTurns = new Set<string>();
  const lastTool = new Map<string, string>();
  let lastShownAt: number | undefined;
  messages.forEach((message, index) => {
    const turnId = message.turnId;
    if (turnId && message.kind === "activity" && message.tool?.name) lastTool.set(turnId, message.tool.name);
    if (quiet && turnId && screenCapture(message, lastTool.get(turnId))) {
      hiddenIds.add(message.id);
      return;
    }
    if (spoken(message)) {
      const first = !spokenTurns.has(message.turnId);
      spokenTurns.add(message.turnId);
      const update = lastShownAt === undefined || message.at - lastShownAt >= UPDATE_GAP_MS;
      const quietable = !message.turnTerminal && !first && !update;
      if (terminals.has(message.turnId)) {
        if (quietable && index < (lastStep.get(message.turnId) ?? -1)) {
          hiddenIds.add(message.id);
          folded.set(message.turnId, [...(folded.get(message.turnId) ?? []), message]);
          return;
        }
      } else if (quietable && quiet && runningSince !== null && message.at >= runningSince) {
        hiddenIds.add(message.id);
        return;
      }
      lastShownAt = message.at;
      return;
    }
    if (message.role === "user" || !QUIET_KINDS.has(message.kind)) lastShownAt = message.at;
  });

  const byAnchorId = new Map<string, TurnFold>();
  for (const [turnId, narration] of folded) {
    const terminal = messages[terminals.get(turnId)!];
    const first = firstIndex.get(turnId)!;
    const before = messages[first - 1];
    const startedAt = before?.role === "user" ? before.at : messages[first].at;
    byAnchorId.set(messages[lastStep.get(turnId)! + 1].id, {
      kind: "turn",
      id: `turn:${turnId}`,
      turnId,
      label: workedLabel(Math.max(0, terminal.at - startedAt)),
      messages: narration,
    });
  }
  return { byAnchorId, hiddenIds };
}

function group(messages: Message[], plan: TranscriptPlan | null): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length > 1) items.push({ kind: "run", id: `run:${run[0].id}`, messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    const turn = plan?.byAnchorId.get(message.id);
    if (turn) {
      flush();
      items.push(turn);
    }
    if (plan?.hiddenIds.has(message.id)) continue;
    if (foldable(message)) {
      const first = run[0];
      if (
        first &&
        (first.role !== message.role ||
          first.from?.botId !== message.from?.botId ||
          localDay(first.at) !== localDay(message.at))
      ) {
        flush();
      }
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: "message", message });
  }
  flush();
  return items;
}

export function groupActivityRuns(messages: Message[]): ActivityTranscriptItem[] {
  return group(messages, null) as ActivityTranscriptItem[];
}

export function groupTranscript(messages: Message[], plan: TranscriptPlan = planTranscript(messages)): TranscriptItem[] {
  return group(messages, plan);
}

const MAX_NAMES = 3;

export function describeRun(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const name = message.tool?.name ?? "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length > MAX_NAMES ? ` ${t("chat.run.more", { count: names.length - MAX_NAMES })}` : "";
  return t("chat.run.steps", { count: messages.length, tools: `${shown}${rest}` });
}
