export const SCREEN_STATES = ["ready", "loading", "login", "two_factor", "captcha", "error", "dialog"] as const;
export type ScreenState = typeof SCREEN_STATES[number];
export const PERSON_STATES: readonly ScreenState[] = ["login", "two_factor", "captcha"];
export const SCREEN_CHECK_MODEL = "clef-flash";
export const SCREEN_CHECK_MAX_IMAGE_CHARS = 190_000;
export const YES = 0.5;

export interface ScreenRead {
  screen: ScreenState;
  probability: number;
}

export interface ScreenChecks {
  state(frame: Buffer, signal: AbortSignal): Promise<ScreenRead | null>;
  irreversible(crop: Buffer, action: string, signal: AbortSignal): Promise<number | null>;
  confirmed(frame: Buffer, action: string, signal: AbortSignal): Promise<number | null>;
}

export type AskClef = (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

const SCREEN_CRITERIA: Record<ScreenState, string> = {
  ready: "A normal screen that has finished loading and is ready to use.",
  loading: "Still loading: a spinner, a progress bar, a blank page or half-drawn content.",
  login: "A sign-in or password page.",
  two_factor: "A request for a verification code or a second sign-in step.",
  captcha: "A captcha or a check that asks you to prove you are human.",
  error: "An error page or an error message.",
  dialog: "A dialog, popup, permission prompt or cookie banner waiting for an answer.",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const probability = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 1000) / 1000 : null);

export function asDataUrl(jpeg: Buffer): string | null {
  const url = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  return url.length <= SCREEN_CHECK_MAX_IMAGE_CHARS ? url : null;
}

export function isPersonState(read: ScreenRead | null): read is ScreenRead {
  return read !== null && PERSON_STATES.includes(read.screen) && read.probability >= YES;
}

export function stateQuestion(image: string): Record<string, unknown> {
  return {
    model: SCREEN_CHECK_MODEL,
    images: [image],
    state: { situation: "A screenshot of a Linux desktop that Claude is using to do a task for a person." },
    questions: { screen: { type: "choice", instructions: "Which best describes the screen?", criteria: SCREEN_CRITERIA } },
  };
}

export function irreversibleQuestion(image: string, action: string): Record<string, unknown> {
  return {
    model: SCREEN_CHECK_MODEL,
    images: [image],
    state: {
      situation: "A crop of a desktop screen. Claude is about to act on the control under the middle of the image.",
      action,
    },
    questions: {
      irreversible: {
        type: "noul",
        instructions: "Would this action submit, pay, publish, cancel or delete something?",
        criteria: {
          true: "It sends a form, pays, places an order, publishes or posts, cancels, deletes or confirms something that cannot simply be undone.",
          false: "It only moves around, opens, types into a field, expands, scrolls or picks an option.",
        },
      },
    },
  };
}

export function confirmedQuestion(image: string, action: string): Record<string, unknown> {
  return {
    model: SCREEN_CHECK_MODEL,
    images: [image],
    state: { situation: "A screenshot taken just after Claude did something that submits, pays, publishes, cancels or deletes.", action },
    questions: {
      confirmed: {
        type: "noul",
        instructions: "Does the screen show that it went through?",
        criteria: {
          true: "A confirmation, receipt, success message, or the next page of the same flow.",
          false: "An error, a page that cannot be reached, a resubmit prompt, a spinner, or the same form as before.",
        },
      },
    },
  };
}

export function readState(body: unknown): ScreenRead | null {
  const answer = isRecord(body) && isRecord(body.answers) && isRecord(body.answers.screen) ? body.answers.screen : null;
  const choice = answer?.choice;
  if (typeof choice !== "string" || !(SCREEN_STATES as readonly string[]).includes(choice)) return null;
  const chosen = isRecord(answer!.probabilities) ? probability(answer!.probabilities[choice]) : null;
  return chosen === null ? null : { screen: choice as ScreenState, probability: chosen };
}

export function readYes(body: unknown, id: string): number | null {
  const answer = isRecord(body) && isRecord(body.answers) && isRecord(body.answers[id]) ? body.answers[id] : null;
  return answer ? probability(answer.noul) : null;
}

export function clefScreenChecks(ask: AskClef): ScreenChecks {
  const asked = async <T>(image: Buffer, question: (url: string) => Record<string, unknown>, read: (body: unknown) => T | null, signal: AbortSignal): Promise<T | null> => {
    const url = asDataUrl(image);
    if (!url) return null;
    try { return read(await ask(question(url), signal)); } catch (error) { if (signal.aborted) throw error; return null; }
  };
  return {
    state: (frame, signal) => asked(frame, stateQuestion, readState, signal),
    irreversible: (crop, action, signal) => asked(crop, (url) => irreversibleQuestion(url, action), (body) => readYes(body, "irreversible"), signal),
    confirmed: (frame, action, signal) => asked(frame, (url) => confirmedQuestion(url, action), (body) => readYes(body, "confirmed"), signal),
  };
}
