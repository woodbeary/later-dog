import { CURSOR_STATES, type CursorState } from "@/components/CursorAvatar";
import { botShowsUnread } from "./bot-unread";
import { lastNonReceipt } from "./receipts";

export type DogState = CursorState;
export const DOG_STATES = CURSOR_STATES;

export const STATE_GROUPS = {
  Lifecycle: ["sleeping", "waking", "idle", "listening", "thinking", "searching", "working"],
  Reactions: [
    "excited",
    "surprised",
    "suspicious",
    "angry",
    "drowsy",
    "happy",
    "curious",
    "confused",
    "bored",
    "proud",
    "shy",
    "sad",
    "laughing",
    "scared",
    "playful",
    "celebrate",
  ],
  "Agent morphs": ["orbit", "radar", "progress"],
  "Product cycle": [
    "spawning",
    "humming",
    "loading",
    "dictating",
    "writing",
    "sending",
    "receiving",
    "uploading",
    "notifying",
    "alerting",
    "dragging",
    "bouncing",
    "powering-down",
  ],
} satisfies Record<string, DogState[]>;

export const DOG_COLOR_NAMES = [
  "yellow",
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "teal",
  "coral",
] as const;

export type DogColor = (typeof DOG_COLOR_NAMES)[number];

export const DEFAULT_DOG_COLOR: DogColor = "yellow";

export function dogTint(color: string | undefined): DogColor {
  return color && Object.hasOwn(DOG_COLORS, color) ? (color as DogColor) : DEFAULT_DOG_COLOR;
}

export const DOG_COLORS = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
} satisfies Record<DogColor, string>;

export const DOG_MOTIONS = [
  "arrive",
  "switch",
  "customize",
  "alert",
  "thinking",
  "working",
  "launch",
  "success",
  "celebrate",
  "blink",
  "surprise",
  "failure",
] as const;

export type DogMotion = "none" | (typeof DOG_MOTIONS)[number];

interface LegacyStates {
  [state: string]: DogState;
}

const LEGACY_STATES: LegacyStates = {
  deadpan: "idle",
  friendly: "happy",
  focused: "working",
  thinking: "thinking",
  excited: "excited",
  sleepy: "drowsy",
  surprised: "surprised",
  skeptical: "suspicious",
  worried: "scared",
  mischievous: "playful",
};

const KNOWN_STATES = new Set<string>(DOG_STATES);

export function normalizeState(value: string | null | undefined): DogState | null {
  if (!value) return null;
  if (KNOWN_STATES.has(value)) return value as DogState;
  return LEGACY_STATES[value] ?? null;
}

export const PICKABLE_STATES: DogState[] = [
  "idle",
  "happy",
  "curious",
  "drowsy",
  "working",
  "thinking",
  "listening",
  "sleeping",
  "suspicious",
  "proud",
];

type MascotMessage = {
  kind: string;
  tool?: { ok?: boolean };
  comm?: unknown;
};

export type MascotBotProfile = {
  name: string;
  title?: string;
  description?: string;
  mascotExpression?: string | null;
  busy?: boolean;
  activity?: string;
  unread?: boolean;
  tasks?: Array<{ unread?: boolean; routineRunId?: string }> | null;
  messages?: MascotMessage[];
};

export function stateForBot(bot: MascotBotProfile): DogState {
  if (bot.activity === "waiting-on-you") return "curious";
  if (bot.busy) return turnState(bot.messages);
  const pinned = normalizeState(bot.mascotExpression);
  if (pinned) return pinned;

  const last = lastNonReceipt(bot.messages);

  if (last?.kind === "activity" && last.tool?.ok === false) return "alerting";
  if (botShowsUnread(bot)) return "notifying";
  if (last?.kind === "options") return "curious";
  return keywordState(bot);
}

export function turnState(messages: readonly MascotMessage[] | undefined): DogState {
  const last = lastNonReceipt(messages);
  return last?.kind === "activity" && last.tool && last.tool.ok === undefined && !last.comm ? "working" : "thinking";
}

export function restingStateForBot(bot: MascotBotProfile): DogState {
  return normalizeState(bot.mascotExpression) ?? keywordState(bot);
}

function keywordState(bot: MascotBotProfile): DogState {
  const profile = `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`.toLowerCase();
  const matches = (words: RegExp) => words.test(profile);

  if (matches(/\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b/)) {
    return "working";
  }
  if (matches(/\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b/)) {
    return "searching";
  }
  if (matches(/\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b/)) {
    return "excited";
  }
  if (matches(/\b(overnight|night|background|async|queue|batch|long-running)\b/)) {
    return "drowsy";
  }
  if (matches(/\b(monitor|monitoring|incident|alert|watch|status|uptime)\b/)) {
    return "radar";
  }
  if (matches(/\b(review|reviewer|audit|critic|critique|quality|qa|test|legal)\b/)) {
    return "suspicious";
  }
  if (matches(/\b(security|secure|compliance|risk|privacy|finance|financial)\b/)) {
    return "scared";
  }
  if (matches(/\b(design|designer|creative|brainstorm|art|illustration|music|story)\b/)) {
    return "playful";
  }
  if (matches(/\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b/)) {
    return "happy";
  }

  return "idle";
}
