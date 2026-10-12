import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { RoutineRunTrigger } from "./routines.ts";

type Card = { requestId?: string; answered?: string; answeredText?: string; dismissed?: boolean; answeredBy?: { kind: string; person?: string } };
type Line = { id: string; role: string; peerAsk?: unknown; sender?: { id?: string }; card?: Card };

export interface CloudLendingTurn {
  request: { messageId?: string; generations: ReadonlySet<string>; stopped?: boolean; automation?: RoutineRunTrigger } | undefined;
  generation: string;
  thread: readonly Line[];
  starters?: readonly (string | undefined)[];
  reportsFromOthers?: boolean;
  ownerPerson: (person: string | undefined) => boolean;
  cardAnswerer: (card: Card) => string | undefined;
  routineRun: () => { triggerSource: RoutineRunTrigger; ownerStarted: boolean; ownerAuthored: boolean } | null;
}

const personOf = (line: Line | undefined) => line?.role === "user" && !line.peerAsk ? line.sender?.id : undefined;

export type CloudLendingRefusal = "unproven" | "not-owner" | "someone-else";

export function cloudHomeLendingRefusal(turn: CloudLendingTurn): CloudLendingRefusal | null {
  const { request } = turn;
  if (!request?.messageId || request.stopped || !request.generations.has(turn.generation)) return "unproven";
  const index = turn.thread.findIndex(line => line.id === request.messageId);
  if (index < 0) return "unproven";
  let owner: boolean;
  if (request.automation === undefined) {
    owner = turn.ownerPerson(personOf(turn.thread[index]));
  } else {
    const run = turn.routineRun();
    owner = request.automation !== "webhook" && Boolean(run) && run!.triggerSource !== "webhook" &&
      run!.ownerAuthored && (run!.triggerSource !== "manual" || run!.ownerStarted);
  }
  if (!owner) return "not-owner";
  if (turn.starters?.some((person) => person !== undefined && !turn.ownerPerson(person))) return "someone-else";
  if (turn.reportsFromOthers) return "someone-else";
  const clean = ownerOnlyConversation(turn.thread, turn.ownerPerson, turn.cardAnswerer,
    request.automation !== undefined ? request.messageId : undefined);
  return clean ? null : "someone-else";
}

export function ownerOnlyConversation(
  thread: readonly Line[],
  ownerPerson: (person: string | undefined) => boolean,
  cardAnswerer: (card: Card) => string | undefined,
  exempt?: string,
): boolean {
  return thread.every(line =>
    (line.role !== "user" || line.id === exempt || ownerPerson(personOf(line))) &&
    (!answeredByPerson(line.card) || ownerPerson(cardAnswerer(line.card!))));
}

function answeredByPerson(card: Card | undefined): boolean {
  if (!card) return false;
  return (Boolean(card.answered) && card.answered !== "unavailable" && card.dismissed !== true) || Boolean(card.answeredText);
}

type RoutineShape = {
  prompt?: string; target?: unknown; botId?: string; groupId?: string; attachments?: { id: string; path: string }[];
  schedule?: unknown; runOn?: string;
};

export function routineFingerprint(routine: RoutineShape): string {
  const attachments = (routine.attachments ?? []).map(attachment => [attachment.id, attachment.path]);
  return createHash("sha256").update(JSON.stringify([
    routine.prompt ?? "", routine.target ?? null, routine.botId ?? "", routine.groupId ?? null, attachments,
    routine.schedule ?? null, routine.runOn ?? null,
  ])).digest("hex");
}

const authorsFile = z.object({
  version: z.literal(1),
  routines: z.record(z.string().max(128), z.string().regex(/^[a-f0-9]{64}$/)),
  writers: z.record(z.string().max(128), z.string().regex(/^p_[\w-]{22}$/)).optional(),
}).strict();

export function createCloudRoutineAuthors(file: string) {
  let routines: Record<string, string> = {};
  let writers: Record<string, string> = {};
  try {
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000) {
        const parsed = authorsFile.parse(JSON.parse(readFileSync(file, "utf8")));
        routines = parsed.routines;
        writers = parsed.writers ?? {};
      }
    }
  } catch { routines = {}; writers = {}; }
  const save = () => writeFileAtomic(file, JSON.stringify({ version: 1, routines, writers }), { mode: 0o600 });
  return {
    record(id: string, routine: RoutineShape) { routines = { ...routines, [id]: routineFingerprint(routine) }; save(); },
    forget(id: string) { if (Object.hasOwn(routines, id)) { const next = { ...routines }; delete next[id]; routines = next; save(); } },
    wrote(id: string, person: string) { if (writers[id] !== person) { writers = { ...writers, [id]: person }; save(); } },
    writer(id: string): string | undefined { return Object.hasOwn(writers, id) ? writers[id] : undefined; },
    remove(id: string) {
      if (!Object.hasOwn(routines, id) && !Object.hasOwn(writers, id)) return;
      const nextRoutines = { ...routines }; delete nextRoutines[id]; routines = nextRoutines;
      const nextWriters = { ...writers }; delete nextWriters[id]; writers = nextWriters;
      save();
    },
    authored(id: string, routine: RoutineShape) { return Object.hasOwn(routines, id) && routines[id] === routineFingerprint(routine); },
    recorded(id: string): boolean { return Object.hasOwn(routines, id); },
    people(): Set<string> { return new Set(Object.values(writers)); },
    reassign(move: (person: string) => boolean, to: string): string[] {
      const moved: string[] = [];
      const next = { ...writers };
      for (const [id, person] of Object.entries(writers)) if (person !== to && move(person)) { next[id] = to; moved.push(id); }
      if (moved.length) { writers = next; save(); }
      return moved;
    },
  };
}
