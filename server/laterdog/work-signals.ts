import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { WorkFacts } from "./work-state.ts";

type Signals = Pick<WorkFacts, "computerWait" | "retry" | "stopped">;

const PERSON_STOPS = new Set(["interrupted", "cancelled"]);
const NOT_A_STOP = new Set(["usage_limit"]);

export class WorkSignals {
  private readonly threads = new Map<string, Signals>();
  private readonly stoppedByYou = new Set<string>();
  private readonly parked = new Set<string>();

  facts(threadId: string): Signals {
    return this.threads.get(threadId) ?? {};
  }

  stopRequested(threadId: string): void {
    this.stoppedByYou.add(threadId);
  }

  stalled(threadId: string): boolean {
    return this.set(threadId, { ...this.facts(threadId), retry: undefined, computerWait: undefined, stopped: { cause: "infrastructure", detail: "stalled" } });
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
    this.stoppedByYou.delete(threadId);
    this.parked.delete(threadId);
  }

  observe(event: RuntimeEvent): boolean {
    const current = this.facts(event.threadId);
    switch (event.type) {
      case "turn.started":
        this.stoppedByYou.delete(event.threadId);
        this.parked.delete(event.threadId);
        return this.set(event.threadId, {});
      case "turn.retrying":
        return this.set(event.threadId, { ...current, retry: { attempt: event.attempt + 1 } });
      case "content.delta":
      case "item.started":
      case "item.completed":
        return current.retry ? this.set(event.threadId, { ...current, retry: undefined }) : false;
      case "turn.wait_started":
        return this.set(event.threadId, { ...current, computerWait: event.holder?.name ? { holder: event.holder.name } : {} });
      case "turn.wait_ended":
        if (event.outcome === "parked") this.parked.add(event.threadId);
        return this.set(event.threadId, { ...current, computerWait: undefined });
      case "session.exited":
        return this.set(event.threadId, { stopped: { cause: "engine", detail: "closed" } });
      case "turn.completed": {
        const byYou = this.stoppedByYou.delete(event.threadId);
        const parked = this.parked.delete(event.threadId);
        const reason = event.stopReason ?? "";
        const stopped = event.ok || parked || NOT_A_STOP.has(reason) ? undefined
          : PERSON_STOPS.has(reason) ? (byYou ? { cause: "you" as const } : current.stopped)
          : current.stopped ?? { cause: "engine" as const };
        return this.set(event.threadId, stopped ? { stopped } : {});
      }
      default:
        return false;
    }
  }

  private set(threadId: string, next: Signals): boolean {
    const clean = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as Signals;
    const before = JSON.stringify(this.threads.get(threadId) ?? {});
    if (Object.keys(clean).length) this.threads.set(threadId, clean);
    else this.threads.delete(threadId);
    return before !== JSON.stringify(clean);
  }
}
