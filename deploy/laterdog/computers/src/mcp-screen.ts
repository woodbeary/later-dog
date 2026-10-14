export const SCREEN_STATES = ["ready", "loading", "login", "two_factor", "captcha", "error", "dialog"] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

export const SCREEN_CHECK_MODEL = "clef-flash";

export type ScreenCheck = {
  screen: ScreenState;
  confidence?: number;
  changed?: number;
  matches_expectation?: number;
  looks: number;
};

type Command = { ok: true; command: string } | { ok: false; message: string };

const BUTTONS: Record<string, number> = { left: 1, middle: 2, right: 3 };
const WHEEL: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const missing = (action: string, needs: string): Command => ({ ok: false, message: `${action} needs ${needs}.` });

export function actionCommand(args: Record<string, unknown>): Command {
  const { action, x, y, to_x: toX, to_y: toY, text, key } = args;
  const button = BUTTONS[typeof args.button === "string" ? args.button : "left"] ?? 1;
  switch (action) {
    case "click":
    case "double_click":
      if (!whole(x) || !whole(y)) return missing(String(action), "x and y");
      return { ok: true, command: `xdotool mousemove --sync ${x} ${y} click${action === "double_click" ? " --repeat 2 --delay 80" : ""} ${button}` };
    case "type":
      if (typeof text !== "string" || text.length === 0) return missing("type", "text");
      if (text.includes("\u0000")) return { ok: false, message: "type text cannot contain a NUL character." };
      return { ok: true, command: `xdotool type --delay 12 -- ${quote(text)}` };
    case "key":
      if (typeof key !== "string" || key.trim().length === 0) return missing("key", "a key name such as Return or ctrl+l");
      return { ok: true, command: `xdotool key -- ${key.trim().split(/\s+/).map(quote).join(" ")}` };
    case "scroll": {
      if ((x === undefined) !== (y === undefined)) return missing("scroll", "both x and y, or neither");
      const wheel = WHEEL[typeof args.direction === "string" ? args.direction : "down"] ?? 5;
      const clicks = whole(args.amount) ? args.amount : 5;
      const move = whole(x) && whole(y) ? `mousemove --sync ${x} ${y} ` : "";
      return { ok: true, command: `xdotool ${move}click --repeat ${clicks} --delay 40 ${wheel}` };
    }
    case "drag":
      if (!whole(x) || !whole(y) || !whole(toX) || !whole(toY)) return missing("drag", "x, y, to_x and to_y");
      return { ok: true, command: `xdotool mousemove --sync ${x} ${y} mousedown ${button} sleep 0.1 mousemove --sync ${toX} ${toY} sleep 0.1 mouseup ${button}` };
    default:
      return { ok: false, message: "action must be click, double_click, type, key, scroll or drag." };
  }
}

const ACTION_TIMEOUT_MS = 20_000;
const TYPE_MS_PER_CHARACTER = 12;
const TYPE_BASE_MS = 5000;

export function actionTimeoutMs(args: Record<string, unknown>): number {
  if (args.action !== "type" || typeof args.text !== "string") return ACTION_TIMEOUT_MS;
  return TYPE_MS_PER_CHARACTER * args.text.length + TYPE_BASE_MS;
}

export function actionSummary(args: Record<string, unknown>): string {
  const { action, x, y, to_x: toX, to_y: toY, text, key } = args;
  const button = typeof args.button === "string" && args.button !== "left" ? `${args.button} ` : "";
  switch (action) {
    case "click":
      return `${button}click at (${String(x)}, ${String(y)})`;
    case "double_click":
      return `${button}double click at (${String(x)}, ${String(y)})`;
    case "type":
      return `typed ${typeof text === "string" ? text.length : 0} characters`;
    case "key":
      return `pressed ${String(key)}`;
    case "scroll":
      return `scrolled ${typeof args.direction === "string" ? args.direction : "down"}`;
    default:
      return `dragged from (${String(x)}, ${String(y)}) to (${String(toX)}, ${String(toY)})`;
  }
}

const SCREEN_CRITERIA: Record<ScreenState, string> = {
  ready: "A normal screen that has finished loading and is ready to use.",
  loading: "Still loading: a spinner, a progress bar, a blank page or half-drawn content.",
  login: "A sign-in or password page.",
  two_factor: "A request for a verification code or a second sign-in step.",
  captcha: "A captcha or a check that asks you to prove you are human.",
  error: "An error page or an error message.",
  dialog: "A dialog, popup, permission prompt or cookie banner waiting for an answer.",
};

export function checkRequest(action: string, expect: string | undefined, before: string, after: string) {
  return {
    model: SCREEN_CHECK_MODEL,
    images: [before, after],
    state: {
      situation: "Two screenshots of a Linux desktop that an agent is controlling.",
      first_image: "The screen before the agent acted.",
      last_image: "The screen after the agent acted.",
      action,
      ...(expect === undefined ? {} : { expected: expect }),
    },
    questions: {
      screen: { type: "choice", instructions: "Look at the last image. Which best describes the screen now?", criteria: SCREEN_CRITERIA },
      changed: {
        type: "noul",
        instructions: "Is the last image different from the first image in the way the action in the state would cause?",
        criteria: { true: "The screen changed the way this action would change it.", false: "The screen is the same, or changed in some unrelated way." },
      },
      ...(expect === undefined
        ? {}
        : { matches_expectation: { type: "noul", instructions: "Does the last image show what the state's expected field describes?" } }),
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const round = (value: number) => Math.round(value * 100) / 100;
const probability = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? round(value) : undefined);

export function readScreenCheck(body: unknown, looks: number): ScreenCheck | null {
  const answers = isRecord(body) && isRecord(body.answers) ? body.answers : undefined;
  const screen = answers && isRecord(answers.screen) ? answers.screen : undefined;
  const choice = screen?.choice;
  if (typeof choice !== "string" || !(SCREEN_STATES as readonly string[]).includes(choice)) return null;
  const chosen = isRecord(screen?.probabilities) ? probability(screen.probabilities[choice]) : undefined;
  const changed = answers && isRecord(answers.changed) ? probability(answers.changed.noul) : undefined;
  const matches = answers && isRecord(answers.matches_expectation) ? probability(answers.matches_expectation.noul) : undefined;
  return {
    screen: choice as ScreenState,
    ...(chosen === undefined ? {} : { confidence: chosen }),
    ...(changed === undefined ? {} : { changed }),
    ...(matches === undefined ? {} : { matches_expectation: matches }),
    looks,
  };
}
