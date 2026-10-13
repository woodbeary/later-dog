import {
  isOpenTakeover,
  TAKEOVER_REASONS,
  type TakeoverReason,
  type TakeoverRequestCardData,
  type TakeoverStatus,
} from "../../shared/takeover.ts";

export const TAKEOVER_STEP_CHARS = 200;

export const TAKEOVER_PROMPT =
  " When a step needs the person on your screen (a sign-in or code you have no Secure Form for, a CAPTCHA, a passkey, a payment or a final yes), do all the legwork first: open the exact page and fill in everything you can, then call request_takeover with that one step and end the turn. later.dog gives them a Take over card and wakes you when they hand the screen back. A sign-in is never a reason to refuse or stop, and passwords and codes never belong in chat.";

export interface TakeoverWait {
  botId: string;
  threadId: string;
  messageId: string;
}

export interface TakeoverControl {
  held: boolean;
  helpOpen: boolean;
}

export interface TakeoverCards {
  read(wait: TakeoverWait): TakeoverRequestCardData | null;
  write(wait: TakeoverWait, next: TakeoverRequestCardData): void;
}

export interface SettledTakeover {
  wait: TakeoverWait;
  outcome: "done" | "skipped";
  step: string;
}

export function parseTakeoverInput(raw: Record<string, unknown>): { step: string; reason: TakeoverReason } | null {
  const step = typeof raw.step === "string" ? raw.step.replace(/\s+/g, " ").trim().slice(0, TAKEOVER_STEP_CHARS).trim() : "";
  if (!step) return null;
  const reason = TAKEOVER_REASONS.find((candidate) => candidate === raw.reason) ?? "other";
  return { step, reason };
}

export function nextTakeoverStatus(current: TakeoverStatus, control: TakeoverControl): TakeoverStatus {
  if (!isOpenTakeover(current)) return current;
  if (control.held) return "in-control";
  if (control.helpOpen) return current;
  return current === "in-control" ? "done" : "skipped";
}

export function finishTakeover(card: TakeoverRequestCardData, outcome: "done" | "skipped" | "replied"): TakeoverRequestCardData | null {
  if (!isOpenTakeover(card.status)) return null;
  if (outcome === "replied" && card.status !== "waiting") return null;
  return { ...card, status: outcome };
}

export class TakeoverWaits {
  private byKey = new Map<string, TakeoverWait[]>();

  add(controlKey: string, wait: TakeoverWait): void {
    for (const [key, list] of this.byKey) {
      const kept = list.filter((entry) => !sameWait(entry, wait));
      if (kept.length) this.byKey.set(key, kept);
      else this.byKey.delete(key);
    }
    this.byKey.set(controlKey, [...(this.byKey.get(controlKey) ?? []), wait]);
  }

  remove(wait: TakeoverWait): void {
    for (const [key, list] of this.byKey) {
      const kept = list.filter((entry) => !sameWait(entry, wait));
      if (kept.length) this.byKey.set(key, kept);
      else this.byKey.delete(key);
    }
  }

  waiting(controlKey: string): readonly TakeoverWait[] {
    return this.byKey.get(controlKey) ?? [];
  }

  settle(controlKey: string, control: TakeoverControl, cards: TakeoverCards): SettledTakeover[] {
    const settled: SettledTakeover[] = [];
    for (const wait of this.waiting(controlKey)) {
      const card = cards.read(wait);
      if (!card || !isOpenTakeover(card.status)) {
        this.remove(wait);
        continue;
      }
      const status = nextTakeoverStatus(card.status, control);
      if (status === card.status) continue;
      cards.write(wait, { ...card, status });
      if (isOpenTakeover(status)) continue;
      this.remove(wait);
      if (status === "done" || status === "skipped") settled.push({ wait, outcome: status, step: card.step });
    }
    return settled;
  }
}

function sameWait(a: TakeoverWait, b: TakeoverWait): boolean {
  return a.threadId === b.threadId && a.messageId === b.messageId;
}

export function takeoverRequestedText(step: string, alreadyInControl: boolean): string {
  return [
    alreadyInControl
      ? `The person already has the screen; their card now says ${JSON.stringify(step)}.`
      : `The person now sees a "needs you" card for ${JSON.stringify(step)} with Take over and Skip.`,
    "End this turn now with one short, friendly line saying what they need to do, for example: \"Tap Take over, sign in, then tap I'm done.\"",
    "Never ask for passwords or codes in chat.",
    "later.dog wakes you automatically when they hand the screen back, skip, or reply.",
  ].join(" ");
}

export function takeoverNeedsComputerText(switchedOff: boolean): string {
  return switchedOff
    ? "Computer use is switched off for this conversation, so there is no screen to hand over. In one short line, ask the person to switch your computer on and say what you will do once it is."
    : "No computer is connected to this conversation yet, so there is no screen to hand over. Connect one with select_computer, open the page that needs the person, then call request_takeover again. A sign-in is never a reason to refuse.";
}

export function takeoverResumePrompt(outcome: "done" | "skipped", step: string): string {
  return outcome === "done"
    ? `later.dog computer update: the person handed the screen back after ${JSON.stringify(step)}. Take a fresh screenshot to check where things stand, then carry on with the task without asking them to repeat it. If it still needs them, ask again with request_takeover.`
    : `later.dog computer update: the person skipped ${JSON.stringify(step)}. Do not ask for the same step again right away. Carry on another way if you can, or tell them in one short line what is still blocked.`;
}
