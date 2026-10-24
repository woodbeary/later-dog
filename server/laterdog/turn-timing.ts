import type { RuntimeEvent } from "../../shared/runtime-events.ts";

const KEPT_TURNS = 200;

interface Timing {
  engine: string;
  asked: number;
  started?: number;
  firstWords?: number;
  model?: string;
}

const after = (from: number, at: number | undefined) => (at === undefined ? "never" : `${((at - from) / 1000).toFixed(1)} s`);

export function createTurnTiming(options: { log: (line: string) => void; now?: () => number }) {
  const now = options.now ?? Date.now;
  const turns = new Map<string, Timing>();
  return {
    asked(threadId: string, engine: string): void {
      turns.delete(threadId);
      turns.set(threadId, { engine, asked: now() });
      if (turns.size > KEPT_TURNS) turns.delete(turns.keys().next().value!);
    },
    event(event: RuntimeEvent): void {
      const timing = turns.get(event.threadId);
      if (!timing) return;
      if (event.type === "turn.started") timing.started ??= now();
      else if (event.type === "session.started" && event.model) timing.model = event.model;
      else if ((event.type === "content.delta" && event.streamKind === "assistant_text") || (event.type === "item.completed" && event.itemType === "assistant_text")) {
        timing.firstWords ??= now();
      } else if (event.type === "turn.completed") {
        turns.delete(event.threadId);
        options.log(`reply timing (${timing.engine}${timing.model ? `, ${timing.model}` : ""}): started ${after(timing.asked, timing.started)}, first words ${after(timing.asked, timing.firstWords)}, done ${after(timing.asked, now())}${event.ok ? "" : ", failed"}`);
      }
    },
  };
}
