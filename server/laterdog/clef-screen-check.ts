import type { Decider } from "../decider/index.ts";
import type { ChoiceAnswer, ChoiceQuestion, YesNoAnswer, YesNoQuestion } from "../decider/types.ts";
import type { Breaker } from "./clef-breaker.ts";
import { createBoundedMap } from "./clef-bounded.ts";
import { fastDecide } from "./clef-fast-decide.ts";
import type { ImageShrinker } from "./clef-images.ts";
import type { ClefLogRow } from "./clef-log.ts";

export const SCREEN_CHECK_BUDGET_MS = 1_500;
export const LOADING_MIN_PROBABILITY = 0.7;
export const SHOWING_MIN_PROBABILITY = 0.7;
export const UNCHANGED_MAX_PROBABILITY = 0.3;
export const MAX_LOADING_WAITS = 3;
export const LOADING_WAIT_MS = 1_000;
export const SCREEN_CHECK_TOTAL_MS = 3_000;
export const ASK_MIN_MS = 300;

export const SECURE_FORM_HINT =
  "A sign-in or verification prompt is showing. Do not type passwords or codes yourself: call request_secure_form so the person fills them in safely, then use fill_secure_field.";
export const CAPTCHA_HINT = "A captcha is showing. Do not try to solve it: call request_takeover so the person can.";

export type ScreenShowing = "nothing" | "login" | "two_factor" | "captcha" | "error" | "dialog";

export interface Shot {
  png: string;
  format: string;
}

export const LOADING_QUESTION: YesNoQuestion = {
  type: "yesno",
  instructions: "Is the last image still loading, for example a spinner, a progress bar, a blank page or a half-drawn window?",
};

export const CHANGED_QUESTION: YesNoQuestion = {
  type: "yesno",
  instructions: "Compared with the first image, did the last image change in the way `last_action` was meant to change it?",
};

export const SHOWING_QUESTION: ChoiceQuestion<ScreenShowing> = {
  type: "choice",
  instructions: "What, if anything, is blocking the last image?",
  options: {
    nothing: "Nothing special: an ordinary page or application.",
    login: "A login or sign-in form asking for a username, email or password.",
    two_factor: "A verification code, two-factor or one-time passcode prompt.",
    captcha: "A captcha or a check that asks whether the visitor is a human.",
    error: "An error message or an error page.",
    dialog: "A dialog box, pop-up or permission prompt waiting for an answer.",
  },
};

export interface ScreenDecision {
  loading: number;
  changed: number | null;
  showing: ScreenShowing;
  showingP: number;
}

export interface ScreenCheckResult {
  shot: Shot;
  text: string | null;
  decision: ScreenDecision | null;
  waits: number;
}

export interface ScreenCheckDeps {
  decider: Pick<Decider, "ask"> | undefined;
  enabled(): boolean;
  record(row: ClefLogRow): void;
  wait?(ms: number, signal?: AbortSignal): Promise<void>;
  shrink?: ImageShrinker;
  budgetMs?: number;
  totalMs?: number;
  loadingWaitMs?: number;
  askMinMs?: number;
  breaker?: Breaker;
  now?: () => number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });

export function describeAction(name: string, args: Record<string, unknown>): string {
  const at = typeof args.x === "number" && typeof args.y === "number" ? ` at ${args.x},${args.y}` : "";
  switch (name) {
    case "click": return `a click${at}`;
    case "move": return `moving the pointer${at}`;
    case "drag": return `a drag${at}`;
    case "scroll": return `scrolling ${String(args.direction ?? "")}${at}`.trim();
    case "key_press": return `pressing ${String(args.key ?? "a key")}`;
    case "type_text": return "typing some text";
    case "open_url": {
      try {
        return `opening ${new URL(String(args.url)).origin}`;
      } catch {
        return "opening a web page";
      }
    }
    default: return name.replace(/_/g, " ");
  }
}

export function describeDecision(decision: ScreenDecision, waits: number, lastAction: string | undefined): string {
  const parts: string[] = [];
  const stillLoading = decision.loading >= LOADING_MIN_PROBABILITY;
  if (waits > 0) parts.push(stillLoading ? `It still looked like it was loading after waiting ${waits}s.` : `Waited ${waits}s for the screen to finish loading.`);
  else if (stillLoading) parts.push("It looks like the screen is still loading.");
  if (decision.showingP >= SHOWING_MIN_PROBABILITY) {
    if (decision.showing === "login" || decision.showing === "two_factor") parts.push(SECURE_FORM_HINT);
    else if (decision.showing === "captcha") parts.push(CAPTCHA_HINT);
    else if (decision.showing === "error") parts.push("An error is showing; read it before going on.");
    else if (decision.showing === "dialog") parts.push("A dialog is showing and may need an answer before anything else works.");
  }
  if (lastAction && decision.changed !== null) {
    parts.push(decision.changed <= UNCHANGED_MAX_PROBABILITY
      ? `The screen did not seem to change after ${lastAction}; it may not have worked.`
      : "The screen changed as intended.");
  }
  if (!parts.length) parts.push("Nothing needs attention.");
  return `Screen check: ${parts.join(" ")}`;
}

export function createScreenCheck(deps: ScreenCheckDeps) {
  const now = deps.now ?? Date.now;
  const previous = createBoundedMap<Shot>({ max: 12, ttlMs: 15 * 60_000, now });
  const actions = createBoundedMap<string>({ max: 12, ttlMs: 15 * 60_000, now });
  const wait = deps.wait ?? sleep;
  const total = deps.totalMs ?? SCREEN_CHECK_TOTAL_MS;
  const loadingWait = deps.loadingWaitMs ?? LOADING_WAIT_MS;
  const askMin = deps.askMinMs ?? ASK_MIN_MS;

  async function ask(boxId: string, shot: Shot, budgetMs: number, signal?: AbortSignal): Promise<ScreenDecision | null> {
    const before = previous.get(boxId);
    const action = actions.get(boxId);
    const compare = Boolean(before && action);
    const images = [...(compare ? [{ data: before!.png, format: before!.format }] : []), { data: shot.png, format: shot.format }];
    const questions = {
      loading: LOADING_QUESTION,
      showing: SHOWING_QUESTION,
      ...(compare ? { changed: CHANGED_QUESTION } : {}),
    };
    const decided = await fastDecide(deps.decider, "screenCheck", { last_action: action ?? "none" }, questions, {
      budgetMs: Math.min(deps.budgetMs ?? SCREEN_CHECK_BUDGET_MS, budgetMs),
      images,
      shrink: deps.shrink,
      breaker: deps.breaker,
      signal,
    });
    if (!decided.decided) {
      deps.record({ kind: "screenCheck", box: boxId, action: "skipped", reason: decided.reason });
      return null;
    }
    const answers = decided.answers as { loading: YesNoAnswer; showing: ChoiceAnswer<ScreenShowing>; changed?: YesNoAnswer };
    return {
      loading: answers.loading.p,
      changed: answers.changed ? answers.changed.p : null,
      showing: answers.showing.choice,
      showingP: answers.showing.pTop,
    };
  }

  return {
    noteAction(boxId: string, name: string, args: Record<string, unknown>): void {
      if (!deps.enabled()) return;
      actions.set(boxId, describeAction(name, args));
    },
    forgetBox(boxId: string): void {
      previous.delete(boxId);
      actions.delete(boxId);
    },
    async afterScreenshot(input: { boxId: string; shot: Shot; capture(): Promise<Shot>; signal?: AbortSignal }): Promise<ScreenCheckResult> {
      if (!deps.enabled()) return { shot: input.shot, text: null, decision: null, waits: 0 };
      const started = now();
      const remaining = () => total - (now() - started);
      let shot = input.shot;
      let waits = 0;
      let decision: ScreenDecision | null = null;
      const loop = (async () => {
        for (;;) {
          decision = await ask(input.boxId, shot, remaining(), input.signal);
          if (!decision || decision.loading < LOADING_MIN_PROBABILITY || waits >= MAX_LOADING_WAITS) break;
          if (remaining() < loadingWait + askMin) break;
          await wait(loadingWait, input.signal);
          input.signal?.throwIfAborted();
          shot = await input.capture();
          waits++;
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hardLimit = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), total + 200);
      });
      try {
        const outcome = await Promise.race([loop.then(() => "done" as const), hardLimit]);
        if (outcome === "late") {
          loop.catch(() => undefined);
          decision = null;
          deps.record({ kind: "screenCheck", box: input.boxId, action: "skipped", reason: "deadline" });
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        decision = null;
      } finally {
        clearTimeout(timer);
      }
      const lastAction = actions.get(input.boxId);
      previous.set(input.boxId, shot);
      actions.delete(input.boxId);
      if (decision) {
        const seen: ScreenDecision = decision;
        deps.record({
          kind: "screenCheck", box: input.boxId, action: "checked", waits,
          loading: seen.loading, showing: seen.showing, showingP: seen.showingP, changed: seen.changed,
        });
      }
      return { shot, decision, waits, text: decision ? describeDecision(decision, waits, lastAction) : null };
    },
  };
}

export type ScreenCheck = ReturnType<typeof createScreenCheck>;

export const screenGuard: { current: ScreenCheck | null } = { current: null };
