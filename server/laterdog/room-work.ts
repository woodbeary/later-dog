import type { WireWaitingOn } from "../../shared/wire.ts";
import type { WorkDog, WorkState } from "../../shared/work-state.ts";
import type { RoomHandoff } from "../room-handoffs.ts";
import { workState } from "./work-state.ts";

export interface RoomMemberFacts {
  dog: WorkDog;
  running: boolean;
  waitingOn: readonly WorkDog[];
}

export interface RoomWorkFacts {
  members: readonly RoomMemberFacts[];
  needsYou?: { what?: string };
  usageHold?: { account?: string; until?: number };
}

export function roomWork(facts: RoomWorkFacts): WorkState {
  const running = facts.members.filter((member) => member.running).map((member) => member.dog);
  const waitingOn: WireWaitingOn[] = facts.members.flatMap((member) => member.waitingOn)
    .map((dog) => ({ botId: dog.id, name: dog.name, ...(dog.ask ? { ask: dog.ask } : {}) }));
  const state = workState({
    busy: running.length > 0,
    waitingOn,
    ...(facts.needsYou ? { needsYou: facts.needsYou } : {}),
    ...(facts.usageHold ? { usageHold: facts.usageHold } : {}),
  });
  if (state.kind !== "running") return state;
  const seen = new Set<string>();
  return { kind: "running", dogs: running.filter((dog) => !seen.has(dog.id) && seen.add(dog.id)) };
}

export interface RoomHandoffView {
  nodes(): Iterable<RoomHandoff>;
  awaited(id: string): readonly RoomHandoff[];
  name(botId: string): string | undefined;
}

const LIVE: ReadonlySet<RoomHandoff["status"]> = new Set(["queued", "running", "waiting", "resume", "needs-you"]);

export function roomMemberFacts(
  group: { id: string; memberIds: readonly string[] },
  turnBotIds: ReadonlySet<string>,
  view: RoomHandoffView,
): { members: RoomMemberFacts[]; needsYouFromHandoff: boolean } {
  const dogOf = (botId: string): WorkDog | undefined => {
    const name = view.name(botId)?.trim();
    return name ? { id: botId, name } : undefined;
  };
  const running = new Set<string>(turnBotIds);
  const waiting = new Map<string, WorkDog[]>();
  let needsYouFromHandoff = false;
  for (const node of view.nodes()) {
    if (node.groupId !== group.id) continue;
    if (node.status === "running" || node.status === "resume") running.add(node.botId);
    if (node.status === "needs-you") needsYouFromHandoff = true;
    if (node.status !== "waiting") continue;
    const on = view.awaited(node.id).filter((child) => LIVE.has(child.status)).flatMap((child) => dogOf(child.botId) ?? []);
    if (on.length) waiting.set(node.botId, [...(waiting.get(node.botId) ?? []), ...on]);
  }
  const members = group.memberIds.flatMap((botId) => {
    const dog = dogOf(botId);
    return dog ? [{ dog, running: running.has(botId), waitingOn: waiting.get(botId) ?? [] }] : [];
  });
  return { members, needsYouFromHandoff };
}

interface RoomLine {
  role: string;
  kind?: string;
  card?: { requestId?: string; title?: string; subtitle?: string; answered?: string; dismissed?: boolean; expired?: boolean };
  needsYou?: { label: string; status: string };
}

export interface RoomWorkDeps extends RoomHandoffView {
  turnBotIds(groupId: string): ReadonlySet<string>;
  threadIds(groupId: string): readonly string[];
  tail(threadId: string): readonly RoomLine[];
  heldUntil(threadId: string): number | undefined;
  holdAccount(groupId: string): string | undefined;
}

const said = (value: string | undefined): string | undefined => value?.trim() || undefined;

function openAskIn(lines: readonly RoomLine[]): { what?: string } | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.needsYou?.status === "waiting") return { what: said(line.needsYou.label) };
    const card = line.card;
    if (line.role === "bot" && card?.requestId && !card.answered && !card.dismissed && !card.expired) return { what: said(card.title) ?? said(card.subtitle) };
  }
  return undefined;
}

export function roomWorkFor(group: { id: string; memberIds: readonly string[] }, deps: RoomWorkDeps): WorkState {
  const { members, needsYouFromHandoff } = roomMemberFacts(group, deps.turnBotIds(group.id), deps);
  const threads = deps.threadIds(group.id);
  const asks = threads.flatMap((threadId) => openAskIn(deps.tail(threadId)) ?? []);
  const needsYou = asks[0] ?? (needsYouFromHandoff ? {} : undefined);
  const holds = threads.flatMap((threadId) => deps.heldUntil(threadId) ?? []);
  const account = holds.length ? deps.holdAccount(group.id) : undefined;
  return roomWork({
    members,
    ...(needsYou ? { needsYou } : {}),
    ...(holds.length ? { usageHold: { ...(account ? { account } : {}), until: Math.min(...holds) } } : {}),
  });
}
