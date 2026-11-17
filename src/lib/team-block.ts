import type { Message } from "@/state/store";
import type { ExchangeEnd, WireExchange } from "../../shared/room-exchange";
import type { WireWaitingOn } from "../../shared/wire";
import type { TranscriptItem } from "./activity-runs";
import { exchangeRow, sentExchange, type ExchangeItem, type ExchangeRow, type QuietTranscriptItem } from "./quiet-lines";
import { bareToolName } from "./tool-words";

export type TeamState =
  | "Sent" | "Asked again" | "Waiting its turn" | "Working" | "Needs you" | "Done"
  | "Stopped by you" | "Stopped" | "Stopped by a local tool" | "Was interrupted" | "Removed"
  | "The chat that asked was deleted" | "Nothing moved for too long" | "Ran out of time" | "Timed out twice"
  | "Reached the longest a task runs alone" | "Never got started" | "Too many requests to the team"
  | "Stopped when later.dog restarted" | "Stopped without finishing" | "Couldn't finish";

export const END_STATES: Readonly<Record<ExchangeEnd, TeamState>> = {
  person: "Stopped by you",
  api: "Stopped by a local tool",
  interrupted: "Was interrupted",
  deleted: "The chat that asked was deleted",
  idle: "Nothing moved for too long",
  capped: "Ran out of time",
  timeout: "Timed out twice",
  ceiling: "Reached the longest a task runs alone",
  origin: "Never got started",
  limit: "Too many requests to the team",
  restart: "Stopped when later.dog restarted",
  problem: "Couldn't finish",
  home: "Stopped without finishing",
};

export function endState(endedBy: string | undefined): TeamState {
  return endedBy && Object.hasOwn(END_STATES, endedBy) ? END_STATES[endedBy as ExchangeEnd] : "Couldn't finish";
}

const SAID: ReadonlyArray<[RegExp, TeamState]> = [
  [/\bwas stopped by a local tool$/, "Stopped by a local tool"],
  [/\bcouldn't start: too many teammate requests$/, "Too many requests to the team"],
  [/\bstopped$/, "Stopped"],
  [/\bran out of time$/, "Ran out of time"],
  [/\bwas interrupted$/, "Was interrupted"],
  [/\bnever got started$/, "Never got started"],
];

export function saidState(words: string | undefined): TeamState {
  const said = (words ?? "").trim().toLowerCase().replace(/[.!]+$/, "").replace(/’/g, "'");
  return SAID.find(([pattern]) => pattern.test(said))?.[1] ?? "Couldn't finish";
}

export interface TeamAsk {
  row: ExchangeRow;
  requestId?: string;
}

export interface TeamItem {
  kind: "team";
  id: string;
  asks: TeamAsk[];
  messages: Message[];
}

export interface FailedSendItem {
  kind: "failed-send";
  id: string;
  message: Message;
  messages: Message[];
}

const SPOKEN_NAMES = /^checking with (.+)$/i;

export function unreachedNames(message: Message): string | null {
  const names = SPOKEN_NAMES.exec(message.tool?.spoken?.trim() ?? "")?.[1]?.trim();
  return names || null;
}

export interface TeamRow {
  ask: TeamAsk;
  gist: string;
  state: TeamState;
  helperThread?: string;
}

function helperThreadOf(record: WireExchange | undefined): string | undefined {
  return record?.threadId || undefined;
}

export const SETTLED: ReadonlySet<TeamState> = new Set<TeamState>([
  "Done", "Asked again", "Stopped by you", "Stopped", "Stopped by a local tool", "Was interrupted", "Removed",
  "The chat that asked was deleted", "Nothing moved for too long", "Ran out of time", "Timed out twice",
  "Reached the longest a task runs alone", "Never got started", "Too many requests to the team",
  "Stopped when later.dog restarted", "Stopped without finishing", "Couldn't finish",
]);

function requestIdOf(message: Message): string | undefined {
  return message.handoffId ?? message.exchange?.id ?? message.roomRequest?.id;
}

function askOf(row: ExchangeRow): TeamAsk {
  const requestId = requestIdOf(row.message);
  return requestId ? { row, requestId } : { row };
}

function leadOf(item: TeamItem): string {
  return item.asks[0]!.row.message.from?.botId ?? "";
}

function sameTurn(item: TeamItem, row: ExchangeRow): boolean {
  const first = item.asks[0]!.row.message;
  return (!first.turnId || !row.message.turnId || first.turnId === row.message.turnId)
    && leadOf(item) === (row.message.from?.botId ?? "");
}

function settlesAsk(row: ExchangeRow): string | null | undefined {
  const message = row.message;
  if (row.direction !== "from" || row.action || message.tool?.ok === false) return undefined;
  if (message.roomRequest) return message.roomRequest.phase === "result" ? message.roomRequest.id : undefined;
  return null;
}

function replyIdOf(message: Message): string | undefined {
  return message.roomRequest?.id ?? message.handoffId;
}

function countsAsReply(message: Message): boolean {
  return !message.roomRequest || message.roomRequest.phase === "result";
}

function matchesById(ask: TeamAsk, id: string | null | undefined): boolean {
  return Boolean(ask.requestId && id);
}

function answersTeam(teams: readonly TeamItem[], item: ExchangeItem, heardFrom: ReadonlySet<TeamAsk>): TeamItem | undefined {
  if (item.rows.length !== 1 || item.folded.length) return undefined;
  const row = item.rows[0]!;
  const id = settlesAsk(row);
  if (id === undefined) return undefined;
  return teams.findLast((team) => team.asks.some((ask) => ask.row.withBotId === row.withBotId
    && (matchesById(ask, id) ? ask.requestId === id : !heardFrom.has(ask))));
}

function noteReplies(teams: readonly TeamItem[], item: ExchangeItem, heardFrom: Set<TeamAsk>): void {
  for (const row of item.rows) {
    if (row.direction !== "from" || !countsAsReply(row.message)) continue;
    const id = replyIdOf(row.message);
    for (const team of teams) {
      for (const ask of team.asks) if (ask.row.withBotId === row.withBotId && !matchesById(ask, id)) heardFrom.add(ask);
    }
  }
}

const TEAM_TOOL = /^(?:coordinate_bots|ask_bot|delegate_bot)$/;

export function isTeamStep(message: Message): boolean {
  return message.kind === "activity" && !message.comm && !message.threadRef && TEAM_TOOL.test(bareToolName(message.tool?.name ?? ""));
}

function joinsTeamQuietly(item: QuietTranscriptItem): Message | null {
  if (item.kind !== "message") return null;
  const message = item.message;
  return isTeamStep(message) && message.tool?.ok !== false ? message : null;
}

export function foldTeams(
  items: readonly QuietTranscriptItem[],
  renders: (item: TranscriptItem) => boolean = () => true,
): Array<QuietTranscriptItem | TeamItem | FailedSendItem> {
  const out: Array<QuietTranscriptItem | TeamItem | FailedSendItem> = [];
  const teams: TeamItem[] = [];
  const heardFrom = new Set<TeamAsk>();
  let open: TeamItem | null = null;
  let held: Array<{ item: QuietTranscriptItem; message: Message }> = [];
  const release = () => {
    out.push(...held.map((entry) => entry.item));
    held = [];
  };
  for (const item of items) {
    if (item.kind === "message" && isTeamStep(item.message) && item.message.tool?.ok === false) {
      release();
      out.push({ kind: "failed-send", id: `failed-send:${item.message.id}`, message: item.message, messages: [item.message] });
      continue;
    }
    const step = joinsTeamQuietly(item);
    if (step) {
      const first = open?.asks[0]!.row.message;
      if (open && first && (!first.turnId || !step.turnId || first.turnId === step.turnId)) open.messages.push(step);
      else held.push({ item, message: step });
      continue;
    }
    if (item.kind === "exchange") {
      const exchange = item;
      if (sentExchange(exchange) && !exchange.folded.length) {
        const rows = exchange.rows;
        const turnId = rows[0]!.message.turnId;
        const steps = held.filter((entry) => !entry.message.turnId || !turnId || entry.message.turnId === turnId);
        held = held.filter((entry) => !steps.includes(entry));
        release();
        const asked = steps.map((entry) => entry.message);
        if (open && rows.every((row) => sameTurn(open!, row))) {
          open.asks.push(...rows.map(askOf));
          open.messages.push(...asked, ...exchange.messages);
          continue;
        }
        open = { kind: "team", id: `team:${exchange.id}`, asks: rows.map(askOf), messages: [...asked, ...exchange.messages] };
        teams.push(open);
        out.push(open);
        continue;
      }
      const answered = answersTeam(teams, exchange, heardFrom);
      noteReplies(teams, exchange, heardFrom);
      if (answered) {
        answered.messages.push(...exchange.messages);
        continue;
      }
    }
    release();
    if ((item.kind === "message" || item.kind === "run") && !renders(item)) {
      out.push(item);
      continue;
    }
    open = null;
    out.push(item);
  }
  release();
  return out;
}

function ownRecord(ask: TeamAsk): WireExchange | undefined {
  const message = ask.row.message;
  if (message.exchange && (!ask.requestId || message.exchange.id === ask.requestId)) return message.exchange;
  return message.exchanges?.find((exchange) => exchange.id === ask.requestId);
}

function heard(ask: TeamAsk, team: TeamItem, thread: readonly Message[]): Message | undefined {
  const start = thread.findIndex((message) => message.id === ask.row.message.id);
  const after = start < 0 ? team.messages : [...team.messages, ...thread.slice(start + 1)];
  let found: Message | undefined;
  let askedAgain = false;
  const seen = new Set<string>();
  for (const message of after) {
    if (seen.has(message.id) || message.id === ask.row.message.id) continue;
    seen.add(message.id);
    const row = exchangeRow(message);
    if (!row || row.withBotId !== ask.row.withBotId) continue;
    if (row.direction === "to") {
      if (message.at > ask.row.message.at) askedAgain = true;
      continue;
    }
    const id = replyIdOf(message);
    if (!countsAsReply(message)) continue;
    if (matchesById(ask, id)) {
      if (id === ask.requestId) found = message;
    } else if (!askedAgain && !found) found = message;
  }
  return found;
}

function recordState(record: WireExchange): TeamState {
  switch (record.status) {
    case "queued": return "Waiting its turn";
    case "running":
    case "waiting": return "Working";
    case "needs-you": return "Needs you";
    case "completed": return record.endedBy === "home" ? endState(record.endedBy) : record.reply ? "Done" : "Working";
    case "failed":
    case "cancelled": return record.endedBy ? endState(record.endedBy) : record.status === "cancelled" ? "Stopped" : "Couldn't finish";
  }
}

const WAITING: Record<NonNullable<WireWaitingOn["state"]>, TeamState> = { queued: "Waiting its turn", running: "Working", needsYou: "Needs you" };

export function teamState(
  ask: TeamAsk,
  team: TeamItem,
  thread: readonly Message[],
  waitingOn: readonly WireWaitingOn[] = [],
  present: (botId: string) => boolean = () => true,
): TeamState {
  const reply = heard(ask, team, thread);
  const record = ownRecord(ask);
  const state: TeamState = reply
    ? reply.tool?.ok === false ? (reply.exchange?.endedBy ? endState(reply.exchange.endedBy) : saidState(reply.tool.name))
      : reply.exchange?.endedBy === "home" || record?.endedBy === "home" ? endState("home") : "Done"
    : record ? recordState(record)
      : (() => {
        const waiting = waitingOn.find((entry) => entry.botId === ask.row.withBotId);
        return waiting ? WAITING[waiting.state ?? "queued"] : "Sent";
      })();
  return !present(ask.row.withBotId) && !SETTLED.has(state) ? "Removed" : state;
}

const GIST_WORDS = 9;

export function gistOf(text: string | undefined, limit = GIST_WORDS): string {
  const line = (text ?? "").replace(/^(?:@\S+\s+)+/, "").replace(/\s+/g, " ").trim();
  const words = line.split(" ").filter(Boolean);
  if (words.length <= limit) return line;
  return `${words.slice(0, limit).join(" ").replace(/[,;:.\-–—]+$/, "")}…`;
}

export function teamRows(
  team: TeamItem,
  thread: readonly Message[],
  waitingOn: readonly WireWaitingOn[] = [],
  present?: (botId: string) => boolean,
): TeamRow[] {
  const rows: TeamRow[] = team.asks.map((ask) => {
    const record = ownRecord(ask);
    const helperThread = helperThreadOf(record);
    return { ask, gist: gistOf(record?.request), state: teamState(ask, team, thread, waitingOn, present), ...(helperThread ? { helperThread } : {}) };
  });
  return rows.map((row, index) => row.state === "Sent" && rows.slice(index + 1).some((later) => later.ask.row.withBotId === row.ask.row.withBotId && later.state !== "Sent")
    ? { ...row, state: "Asked again" as const }
    : row);
}

export function teamHeading(rows: readonly TeamRow[]): { dogs: number; done: number } {
  const latest = new Map(rows.map((row) => [row.ask.row.withBotId, row.state]));
  return { dogs: latest.size, done: [...latest.values()].filter((state) => state === "Done").length };
}

function urgency(state: TeamState): number {
  if (state === "Needs you") return 0;
  if (SETTLED.has(state) && state !== "Done" && state !== "Asked again") return 1;
  return 2;
}

export function needsFirst(rows: readonly TeamRow[]): TeamRow[] {
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => urgency(a.row.state) - urgency(b.row.state) || a.index - b.index)
    .map((entry) => entry.row);
}
