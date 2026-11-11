import { readFileSync } from "node:fs";
import { join } from "node:path";

import { jevRequestBody, parseJevResponse } from "../../server/decider/jev.ts";
import { roomRoutingRequest, type RoomRoutingInput } from "../../server/decider/room-routing.ts";
import type { ChoiceAnswer, DeciderQuestion, YesNoAnswer } from "../../server/decider/types.ts";
import { heavyCommandKind } from "../../server/laterdog/heavy-commands.ts";
import { reciprocalRank, type Graded } from "./metrics.ts";

export const DECISION_MODELS = ["clef", "clef-flash"] as const;
export type DecisionModel = (typeof DECISION_MODELS)[number];
export const DECISION_CASES = ["roomRouting", "heavyCommand", "waitingOnOwner", "dogRanking"] as const;
export type DecisionCase = (typeof DECISION_CASES)[number];
export const DOLLARS_PER_MILLION_INPUT = { clef: 0.24, "clef-flash": 0.038, clairic: 0.1 } as const;

export const HEAVY_COMMAND_QUESTION = {
  type: "yesno" as const,
  instructions: "Would running `command` load a shared machine for more than a few seconds?",
  criteria: {
    yes: "It runs a package install, a build, a type check, a test run, a dev server, a browser install or browser test run, a container build, or media processing.",
    no: "It only reads, lists, searches, prints, edits or moves files, asks for a version or help, checks processes, or writes a script without running it.",
  },
};

export const WAITING_ON_OWNER_QUESTION = {
  type: "yesno" as const,
  instructions: "Is the dog that wrote `last_message` unable to continue until its owner answers, approves, supplies something or acts?",
  criteria: {
    yes: "The work is stopped on the owner: a decision, an approval, a credential, a file, a sign-in, a payment or a takeover is needed.",
    no: "The work is finished, still running, waiting on another dog, or the message only reports, explains or offers an optional follow-up.",
  },
};

export const DOG_RANKING_INSTRUCTIONS = "Which dog should take `request`?";

const FIXTURES = join(import.meta.dirname, "fixtures");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

interface RoomFixture {
  rooms: Record<string, { name: string; humans: string[]; members: RoomRoutingInput["members"] }>;
  items: Array<{ id: string; set: string; room: string; from?: string; recent?: RoomRoutingInput["recent"]; message: string; gold: string[] }>;
}
interface HeavyFixture { items: Array<{ id: string; command: string; heavy: boolean }> }
interface WaitingFixture { items: Array<{ id: string; message: string; waiting: boolean }> }
interface RankingFixture {
  dogs: Array<{ id: string; name: string; title: string; description: string }>;
  items: Array<{ id: string; request: string; primary: string; acceptable: string[] }>;
}

export interface DecisionItem {
  id: string;
  group: DecisionCase;
  state: unknown;
  question: DeciderQuestion;
  gold: { kind: "yesno"; yes: boolean } | { kind: "choice"; accepted: string[]; primary?: string } | { kind: "unscored" };
  rule: RuleAnswer;
  applyRule: () => RuleAnswer;
}

export type RuleAnswer = { kind: "yesno"; yes: boolean } | { kind: "choice"; choice: string };

const ruled = (applyRule: () => RuleAnswer) => ({ applyRule, rule: applyRule() });

const NAMED = (name: string) => new RegExp(`(?:^|[^A-Za-z0-9])@?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z0-9]|$)`, "i");

export function ruleRoomResponder(message: string, members: RoomRoutingInput["members"]): string {
  const named = members.filter((member) => NAMED(member.name).test(message));
  return named.length === 1 ? named[0]!.id : members[0]!.id;
}

const WAITING_WORDS = /\b(?:should i|do you want|which (?:one|option|of)|tell me|need(?:s)? (?:you|your)|please (?:confirm|approve|choose|pick|send|sign|take over|add)|waiting (?:for|on) (?:you|your)|say go|reply \w+ to|cannot (?:go|continue|proceed)|can't (?:go|continue|proceed)|send (?:it|me))\b/i;

export function ruleWaitingOnOwner(message: string): boolean {
  return message.trim().endsWith("?") || WAITING_WORDS.test(message);
}

const STOP_WORDS = new Set("the a an and or of on in to for is it its my me i with from that this at be by as are was will can do does not no so if then than there their they you your we our when which what who how after before into out up all any some one two more less last next new old".split(" "));
const words = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word)).map((word) => word.replace(/(?:ing|ed|es|s)$/, ""));

export function ruleDogRanking(request: string, dogs: RankingFixture["dogs"]): string {
  const asked = new Set(words(request));
  let best = dogs[0]!.id;
  let bestScore = -1;
  for (const dog of dogs) {
    const score = words(`${dog.title} ${dog.description}`).filter((word) => asked.has(word)).length;
    if (score > bestScore) {
      best = dog.id;
      bestScore = score;
    }
  }
  return best;
}

export function decisionItems(): DecisionItem[] {
  const rooms = readJson<RoomFixture>(join(import.meta.dirname, "..", "..", "server", "decider", "fixtures", "room-routing.json"));
  const heavy = readJson<HeavyFixture>(join(FIXTURES, "heavy-commands.json"));
  const waiting = readJson<WaitingFixture>(join(FIXTURES, "waiting-on-owner.json"));
  const ranking = readJson<RankingFixture>(join(FIXTURES, "dog-ranking.json"));
  const items: DecisionItem[] = [];
  for (const item of rooms.items) {
    const room = rooms.rooms[item.room]!;
    const { state, question } = roomRoutingRequest({
      room: room.name, humans: room.humans, members: room.members, recent: item.recent ?? [],
      message: { from: item.from ?? "Sam", text: item.message },
    });
    items.push({
      id: item.id,
      group: "roomRouting",
      state,
      question: { type: "choice", ...question },
      gold: item.gold.includes("nobody") ? { kind: "unscored" } : { kind: "choice", accepted: item.gold },
      ...ruled(() => ({ kind: "choice", choice: ruleRoomResponder(item.message, room.members) })),
    });
  }
  for (const item of heavy.items) {
    items.push({
      id: item.id,
      group: "heavyCommand",
      state: { command: item.command },
      question: HEAVY_COMMAND_QUESTION,
      gold: { kind: "yesno", yes: item.heavy },
      ...ruled(() => ({ kind: "yesno", yes: heavyCommandKind(item.command) !== null })),
    });
  }
  for (const item of waiting.items) {
    items.push({
      id: item.id,
      group: "waitingOnOwner",
      state: { last_message: item.message },
      question: WAITING_ON_OWNER_QUESTION,
      gold: { kind: "yesno", yes: item.waiting },
      ...ruled(() => ({ kind: "yesno", yes: ruleWaitingOnOwner(item.message) })),
    });
  }
  const options = Object.fromEntries(ranking.dogs.map((dog) => [dog.id, `${dog.name}, ${dog.title} dog. ${dog.description}`]));
  for (const item of ranking.items) {
    items.push({
      id: item.id,
      group: "dogRanking",
      state: { request: item.request },
      question: { type: "choice", instructions: DOG_RANKING_INSTRUCTIONS, options },
      gold: { kind: "choice", accepted: item.acceptable, primary: item.primary },
      ...ruled(() => ({ kind: "choice", choice: ruleDogRanking(item.request, ranking.dogs) })),
    });
  }
  return items;
}

export interface PlannedCall {
  id: string;
  group: string;
  model: string;
  item: string;
  body: Record<string, unknown>;
}

export function decisionCalls(items: readonly DecisionItem[], models: readonly DecisionModel[]): PlannedCall[] {
  return models.flatMap((model) => items.map((item) => ({
    id: `${model}:${item.group}:${item.id}`,
    group: item.group,
    model,
    item: item.id,
    body: { ...jevRequestBody(item.state, { answer: item.question }), model },
  })));
}

export function ruleCorrect(item: DecisionItem): boolean | null {
  if (item.gold.kind === "unscored") return null;
  if (item.gold.kind === "yesno") return item.rule.kind === "yesno" && item.rule.yes === item.gold.yes;
  return item.rule.kind === "choice" && item.gold.accepted.includes(item.rule.choice);
}

export type DecisionGrade =
  | { ok: false }
  | { ok: true; graded: Graded | null; confidence: number; reciprocalRank?: number; primaryCorrect?: boolean };

export function gradeDecision(item: DecisionItem, result: unknown): DecisionGrade {
  const parsed = parseJevResponse(result, { answer: item.question });
  if (!parsed.ok) return { ok: false };
  const answer = parsed.answers.answer as ChoiceAnswer | YesNoAnswer;
  if (answer.type === "yesno") {
    const confidence = Math.max(answer.p, 1 - answer.p);
    if (item.gold.kind !== "yesno") return { ok: true, graded: null, confidence };
    return { ok: true, confidence, graded: { id: item.id, correct: (answer.p >= 0.5) === item.gold.yes, confidence } };
  }
  const confidence = answer.pTop;
  if (item.gold.kind !== "choice") return { ok: true, graded: null, confidence };
  const probabilities = answer.probabilities as Record<string, number>;
  return {
    ok: true,
    confidence,
    graded: { id: item.id, correct: item.gold.accepted.includes(answer.choice), confidence },
    ...(item.gold.primary ? { reciprocalRank: reciprocalRank(probabilities, item.gold.primary), primaryCorrect: answer.choice === item.gold.primary } : {}),
  };
}
