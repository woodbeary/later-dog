import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";
import type { DogColor, OptionCardData, RoutinePauseCardData } from "../../shared/wire.ts";

export const UNREAD_RESULTS_BEFORE_PAUSE = 5;
export const AWAY_BEFORE_PAUSE_MS = 24 * 60 * 60_000;
export const ROUTINE_PAUSE_ANSWERS = {
  resume: "Start them again",
  keepRunning: "Keep running, don't ask again",
  keepPaused: "Keep them paused",
} as const;

interface WatchedDog {
  unread: number;
  since: number | null;
  keepRunning?: boolean;
}

interface PauseRoutine {
  id: string;
  botId: string;
  name: string;
  enabled: boolean;
}

export interface RoutinePauseDeps {
  file: string;
  now: () => number;
  routines: {
    listRoutines(): PauseRoutine[];
    update(id: string, patch: { enabled: boolean }): unknown;
  };
  bot(botId: string): { id: string; name: string; color: DogColor; threadId: string } | null;
  appendMessage(threadId: string, message: { role: "bot"; kind: "options"; text: string; from: { botId: string; name: string; color: DogColor }; card: OptionCardData }): { id: string };
}

export function routinePauseCard(names: readonly string[], routineIds: readonly string[], unread: number): OptionCardData {
  const named = names.length === 1 ? `“${names[0]}”` : `${names.length} routines`;
  return {
    title: "I paused my routines while you were away",
    subtitle: `${unread} results in a row went unread, so I stopped ${named} to avoid spending for nothing. Want them running again?`,
    options: [ROUTINE_PAUSE_ANSWERS.resume, ROUTINE_PAUSE_ANSWERS.keepRunning, ROUTINE_PAUSE_ANSWERS.keepPaused],
    routinePause: { version: 1, routineIds: [...routineIds] },
  };
}

export function routinePauseOutcome(answer: string): NonNullable<RoutinePauseCardData["outcome"]> | null {
  if (answer === ROUTINE_PAUSE_ANSWERS.resume) return "resumed";
  if (answer === ROUTINE_PAUSE_ANSWERS.keepRunning) return "keep-running";
  if (answer === ROUTINE_PAUSE_ANSWERS.keepPaused) return "kept";
  return null;
}

export class RoutinePauses {
  private readonly deps: RoutinePauseDeps;
  private dogs: Record<string, WatchedDog>;

  constructor(deps: RoutinePauseDeps) {
    this.deps = deps;
    this.dogs = RoutinePauses.read(deps.file);
  }

  private static read(file: string): Record<string, WatchedDog> {
    if (!existsSync(file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, WatchedDog> : {};
    } catch {
      return {};
    }
  }

  private save() {
    writeFileAtomic(this.deps.file, `${JSON.stringify(this.dogs, null, 2)}\n`);
  }

  watched(botId: string): Readonly<WatchedDog> {
    return this.dogs[botId] ?? { unread: 0, since: null };
  }

  seen(botId: string) {
    const dog = this.dogs[botId];
    if (!dog || (dog.unread === 0 && dog.since === null)) return;
    this.dogs[botId] = { ...dog, unread: 0, since: null };
    this.save();
  }

  result(botId: string): { paused: string[]; messageId: string } | null {
    const now = this.deps.now();
    const dog = this.dogs[botId] ?? { unread: 0, since: null };
    const next: WatchedDog = { ...dog, unread: dog.unread + 1, since: dog.since ?? now };
    this.dogs[botId] = next;
    const due = !next.keepRunning && next.unread >= UNREAD_RESULTS_BEFORE_PAUSE && now - next.since! >= AWAY_BEFORE_PAUSE_MS;
    const bot = due ? this.deps.bot(botId) : null;
    const running = bot ? this.deps.routines.listRoutines().filter((routine) => routine.botId === botId && routine.enabled) : [];
    if (!bot || running.length === 0) {
      this.save();
      return null;
    }
    for (const routine of running) this.deps.routines.update(routine.id, { enabled: false });
    this.dogs[botId] = { ...next, unread: 0, since: null };
    this.save();
    const card = routinePauseCard(running.map((routine) => routine.name), running.map((routine) => routine.id), next.unread);
    const message = this.deps.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      text: `${card.title}. ${card.subtitle}`,
      from: { botId: bot.id, name: bot.name, color: bot.color },
      card,
    });
    return { paused: running.map((routine) => routine.id), messageId: message.id };
  }

  answer(botId: string, card: OptionCardData, answer: string): OptionCardData | null {
    const pause = card.routinePause;
    const outcome = pause && !pause.outcome ? routinePauseOutcome(answer) : null;
    if (!pause || !outcome) return null;
    if (outcome !== "kept") {
      const paused = new Set(pause.routineIds);
      for (const routine of this.deps.routines.listRoutines()) {
        if (routine.botId === botId && paused.has(routine.id) && !routine.enabled) this.deps.routines.update(routine.id, { enabled: true });
      }
    }
    const dog = this.dogs[botId] ?? { unread: 0, since: null };
    this.dogs[botId] = { ...dog, unread: 0, since: null, ...(outcome === "keep-running" ? { keepRunning: true } : {}) };
    this.save();
    return { ...card, routinePause: { ...pause, outcome } };
  }
}
