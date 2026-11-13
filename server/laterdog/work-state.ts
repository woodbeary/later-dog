import type { WireWaitingOn } from "../../shared/wire.ts";
import type { WorkStopCause, WorkStopDetail, WorkState } from "../../shared/work-state.ts";

export interface WorkFacts {
  busy: boolean;
  helpers?: number;
  computerJobs?: number;
  handoffRunning?: boolean;
  needsYou?: { what?: string };
  usageHold?: { account?: string; until?: number };
  waitingOn?: readonly WireWaitingOn[];
  computerWait?: { holder?: string };
  retry?: { attempt?: number };
  stopped?: { cause: WorkStopCause; detail?: WorkStopDetail };
}

const said = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function workState(facts: WorkFacts): WorkState {
  if (facts.needsYou) {
    const what = said(facts.needsYou.what);
    return { kind: "needs-you", ...(what ? { what } : {}) };
  }
  if (facts.usageHold) {
    const account = said(facts.usageHold.account);
    const until = facts.usageHold.until;
    return { kind: "waiting-for-usage", ...(account ? { account } : {}), ...(until !== undefined && Number.isFinite(until) ? { until } : {}) };
  }
  const dogs = (facts.waitingOn ?? []).filter((dog) => said(dog.name));
  if (dogs.length) {
    const seen = new Set<string>();
    return {
      kind: "waiting-on-dog",
      dogs: dogs.filter((dog) => !seen.has(dog.botId) && seen.add(dog.botId)).map((dog) => {
        const ask = said(dog.ask);
        return { id: dog.botId, name: dog.name.trim(), ...(ask ? { ask } : {}) };
      }),
    };
  }
  if (facts.computerWait) {
    const holder = said(facts.computerWait.holder);
    return { kind: "waiting-for-computer", ...(holder ? { holder } : {}) };
  }
  if (facts.retry) {
    const attempt = facts.retry.attempt;
    return { kind: "retrying", ...(attempt !== undefined && Number.isInteger(attempt) && attempt > 0 ? { attempt } : {}) };
  }
  const helpers = Math.max(0, facts.helpers ?? 0);
  const computerJobs = Math.max(0, facts.computerJobs ?? 0);
  if (facts.busy || facts.handoffRunning || helpers > 0 || computerJobs > 0) {
    return { kind: "running", ...(helpers ? { helpers } : {}), ...(computerJobs ? { computerJobs } : {}) };
  }
  if (facts.stopped) return { kind: "stopped", cause: facts.stopped.cause, ...(facts.stopped.detail ? { detail: facts.stopped.detail } : {}) };
  return { kind: "idle" };
}

interface AskMessage {
  role: string;
  card?: { title?: string; subtitle?: string; answered?: string; dismissed?: boolean; expired?: boolean };
  needsYou?: { label: string; status: string };
}

export function openAsk(messages: readonly AskMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.needsYou?.status === "waiting") return said(message.needsYou.label);
    const card = message.card;
    if (message.role === "bot" && card && !card.answered && !card.dismissed && !card.expired) return said(card.title) ?? said(card.subtitle);
  }
  return undefined;
}
