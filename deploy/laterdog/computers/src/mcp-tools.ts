export const MCP_SERVER_NAME = "laterdog-computers";
export const MCP_SERVER_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;

export const COMPUTER_ID_PATTERN = "^cmp_[a-z2-7]{12}$";
export const COMPUTER_SIZES = ["small", "standard", "large", "xlarge"] as const;
export const CLICK_BUTTONS = ["left", "middle", "right"] as const;
export const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export const ACTIONS = ["click", "double_click", "type", "key", "scroll", "drag"] as const;
export const DECIDE_TOOL_MODELS = ["clef", "clef-flash"] as const;

export const SCREEN_MAX = 10_000;
export const TYPE_MAX_CHARS = 2000;
export const KEY_MAX_CHARS = 100;
export const EXPECT_MAX_CHARS = 300;
export const SCROLL_MAX_CLICKS = 30;
export const EXEC_TOOL_DEFAULT_TIMEOUT_MS = 30_000;
export const EXEC_TOOL_MAX_TIMEOUT_MS = 600_000;
export const COMMAND_TOOL_MAX_CHARS = 100_000;
export const DECIDE_TOOL_MAX_QUESTIONS = 4;
export const DECIDE_TOOL_MAX_IMAGES = 4;
export const DECIDE_TOOL_MAX_CRITERIA = 64;
export const DECIDE_TOOL_MAX_TEXT_CHARS = 600;

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: readonly unknown[];
  const?: unknown;
  default?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  maxProperties?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  propertyNames?: { pattern: string };
  oneOf?: readonly JsonSchema[];
};

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object"; properties: Record<string, JsonSchema>; additionalProperties: false };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const computerId: JsonSchema = {
  type: "string",
  pattern: COMPUTER_ID_PATTERN,
  description: "The computer's id, like cmp_abcdefghij23. Get it from computer_list or computer_create.",
};
const coordinate = (axis: string): JsonSchema => ({
  type: "integer",
  minimum: 0,
  maximum: SCREEN_MAX,
  description: `The ${axis} position in screenshot pixels, counted from the top left corner.`,
});

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const ACT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const choiceQuestion: JsonSchema = {
  type: "object",
  description: "Pick one option. criteria maps each option's name to a short description of when to pick it.",
  properties: {
    type: { const: "choice" },
    instructions: { type: "string", minLength: 1, maxLength: DECIDE_TOOL_MAX_TEXT_CHARS },
    criteria: {
      type: "object",
      minProperties: 2,
      maxProperties: DECIDE_TOOL_MAX_CRITERIA,
      propertyNames: { pattern: "^[A-Za-z0-9_.-]{1,100}$" },
      additionalProperties: { type: "string", maxLength: DECIDE_TOOL_MAX_TEXT_CHARS },
    },
  },
  required: ["type", "instructions", "criteria"],
  additionalProperties: false,
};
const scoreQuestion: JsonSchema = {
  type: "object",
  description: "Rate on a scale. criteria lists the levels from lowest to highest.",
  properties: {
    type: { const: "score" },
    instructions: { type: "string", minLength: 1, maxLength: DECIDE_TOOL_MAX_TEXT_CHARS },
    criteria: { type: "array", minItems: 2, maxItems: 10, items: { type: "string", maxLength: DECIDE_TOOL_MAX_TEXT_CHARS } },
  },
  required: ["type", "instructions", "criteria"],
  additionalProperties: false,
};
const yesNoQuestion: JsonSchema = {
  type: "object",
  description: "A yes or no question. The answer is the probability of yes. criteria may describe what true and false mean.",
  properties: {
    type: { const: "noul" },
    instructions: { type: "string", minLength: 1, maxLength: DECIDE_TOOL_MAX_TEXT_CHARS },
    criteria: {
      type: "object",
      properties: {
        true: { type: "string", maxLength: DECIDE_TOOL_MAX_TEXT_CHARS },
        false: { type: "string", maxLength: DECIDE_TOOL_MAX_TEXT_CHARS },
      },
      additionalProperties: false,
    },
  },
  required: ["type", "instructions"],
  additionalProperties: false,
};

export const TOOLS: readonly McpToolDefinition[] = [
  {
    name: "computer_list",
    description: "List your later.dog cloud computers with each one's id, name, size and state (starting, running, sleeping or error).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List cloud computers", ...READ },
  },
  {
    name: "computer_create",
    description:
      "Create a cloud computer: a Linux desktop with Xfce, Chromium, git and Node that you drive with computer_action and computer_exec. "
      + "It takes about 20 seconds to start, so call computer_wake next to wait until it is running. "
      + "Trial computers have open internet access and passwordless root: do not put anything on one that you would not hand to a stranger. "
      + "The size defaults to small (standard-1); a free trial always gets the standard size.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "A short name for the computer. Optional." },
        size: { type: "string", enum: COMPUTER_SIZES, description: "small is standard-1, standard is standard-2, large is standard-3 and xlarge is standard-4." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Create a cloud computer", ...ADD },
  },
  {
    name: "computer_wake",
    description:
      "Start a sleeping computer, or wait for a new one to finish starting. It returns once the computer is running, "
      + "or says it is still starting after 30 seconds, in which case call it again. A computer that slept comes back with its files but not its open programs.",
    inputSchema: { type: "object", properties: { computer_id: computerId }, required: ["computer_id"], additionalProperties: false },
    annotations: { title: "Wake a cloud computer", ...WRITE },
  },
  {
    name: "computer_sleep",
    description: "Put a computer to sleep. It keeps its files, stops using compute time, and computer_wake brings it back. Anything that was open on screen is closed.",
    inputSchema: { type: "object", properties: { computer_id: computerId }, required: ["computer_id"], additionalProperties: false },
    annotations: { title: "Sleep a cloud computer", ...WRITE },
  },
  {
    name: "computer_screenshot",
    description: "Take a screenshot of the computer's whole screen, mouse pointer included. The computer must be running.",
    inputSchema: { type: "object", properties: { computer_id: computerId }, required: ["computer_id"], additionalProperties: false },
    annotations: { title: "Screenshot a cloud computer", ...READ },
  },
  {
    name: "computer_action",
    description:
      "Use the mouse or keyboard on the computer, then get a fresh screenshot plus a screen check from the Clef decision model: "
      + "what the screen shows now (ready, loading, login, two_factor, captcha, error or dialog), whether it changed because of your action, "
      + "and whether it matches what you expected. While the screen is still loading it looks again up to 3 times, about a second apart. "
      + "click, double_click and scroll need x and y (scroll without them scrolls where the pointer is); type needs text; key needs a key name such as Return, ctrl+l or alt+Left; drag needs x, y, to_x and to_y. "
      + "The screen check is a guess: read the screenshot before you rely on it. "
      + "Each action uses up to four of the key's daily decisions; if decisions are unavailable you still get the screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: computerId,
        action: { type: "string", enum: ACTIONS },
        x: coordinate("horizontal"),
        y: coordinate("vertical"),
        to_x: coordinate("horizontal drop"),
        to_y: coordinate("vertical drop"),
        button: { type: "string", enum: CLICK_BUTTONS, description: "Which mouse button to click. Defaults to left." },
        text: { type: "string", minLength: 1, maxLength: TYPE_MAX_CHARS, description: "For type: the text to type. A new line presses Return." },
        key: { type: "string", pattern: "^[A-Za-z0-9_+ -]{1,100}$", description: "For key: an xdotool key name or combination, such as Return, ctrl+l, alt+Left or ctrl+shift+t. Separate several with spaces." },
        direction: { type: "string", enum: SCROLL_DIRECTIONS, description: "For scroll. Defaults to down." },
        amount: { type: "integer", minimum: 1, maximum: SCROLL_MAX_CLICKS, description: "For scroll: how many wheel clicks. Defaults to 5." },
        expect: { type: "string", minLength: 1, maxLength: EXPECT_MAX_CHARS, description: "Optional. What you expect the screen to show afterwards, in plain words. The screen check says whether it does." },
      },
      required: ["computer_id", "action"],
      additionalProperties: false,
    },
    annotations: { title: "Use the mouse or keyboard", ...ACT },
  },
  {
    name: "computer_exec",
    description:
      "Run a shell command on the computer as its user, with bash. You get the exit code, stdout, stderr and whether it timed out. "
      + "Commands see the desktop, so xdotool, xclip and chromium work. Output is cut at 1 MB.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: computerId,
        command: { type: "string", minLength: 1, maxLength: COMMAND_TOOL_MAX_CHARS },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: EXEC_TOOL_MAX_TIMEOUT_MS,
          description: `How long to let it run, in milliseconds. Defaults to ${EXEC_TOOL_DEFAULT_TIMEOUT_MS}.`,
        },
        cwd: { type: "string", minLength: 1, maxLength: 4096, description: "The folder to run in. Defaults to the home folder." },
      },
      required: ["computer_id", "command"],
      additionalProperties: false,
    },
    annotations: { title: "Run a command", ...ACT },
  },
  {
    name: "computer_viewer_link",
    description:
      "Make a signed link a person opens in a browser to watch the computer's screen live and take over the mouse and keyboard. "
      + "The link expires; treat it like a password and share it only with the person you work for.",
    inputSchema: { type: "object", properties: { computer_id: computerId }, required: ["computer_id"], additionalProperties: false },
    annotations: { title: "Get a viewer link", ...WRITE },
  },
  {
    name: "decide",
    description:
      "Ask the Clef decision model a quick question and get probabilities back in about a second. "
      + "Send a state (any JSON that gives the facts), one to four named questions (choice, score or noul, as in the Jev format) and optionally up to four images. "
      + "Use it for fast checks such as which option fits, how bad something is, or whether a screenshot shows a login. "
      + "It needs a free trial or later.dog Cloud key, and counts toward that key's daily decisions.",
    inputSchema: {
      type: "object",
      properties: {
        state: { description: "Anything JSON that the questions are about. Up to 24,000 bytes." },
        questions: {
          type: "object",
          minProperties: 1,
          maxProperties: DECIDE_TOOL_MAX_QUESTIONS,
          propertyNames: { pattern: "^[a-z][a-z0-9_]{0,31}$" },
          description: "Question ids mapped to questions. Each is a choice, score or noul question.",
          additionalProperties: { oneOf: [choiceQuestion, scoreQuestion, yesNoQuestion] },
        },
        images: {
          type: "array",
          maxItems: DECIDE_TOOL_MAX_IMAGES,
          items: { type: "string", pattern: "^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$" },
          description: "Up to four JPEG, PNG or WebP images as base64 data URLs, each under 190,000 characters.",
        },
        computer_id: { ...computerId, description: "Optional. Adds a fresh screenshot of this computer as the last image. It counts toward the four." },
        model: { type: "string", enum: DECIDE_TOOL_MODELS, description: "clef is the default; clef-flash is faster and less careful." },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
    annotations: { title: "Ask the decision model", ...READ },
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function hasType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

const named = (path: string) => (path === "" ? "The arguments" : `"${path}"`);

function discriminator(schemas: readonly JsonSchema[]): string[] | null {
  const values = schemas.map((schema) => schema.properties?.type?.const);
  return values.every((value) => typeof value === "string") ? (values as string[]) : null;
}

export function schemaProblem(schema: JsonSchema, value: unknown, path = ""): string | null {
  const label = named(path);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => hasType(value, type))) return `${label} must be ${types.map((type) => (type === "integer" ? "a whole number" : `a${"aeiou".includes(type[0]!) ? "n" : ""} ${type}`)).join(" or ")}.`;
  }
  if (schema.const !== undefined && value !== schema.const) return `${label} must be ${JSON.stringify(schema.const)}.`;
  if (schema.enum && !schema.enum.includes(value)) return `${label} must be one of ${schema.enum.join(", ")}.`;
  if (schema.oneOf) {
    const kinds = discriminator(schema.oneOf);
    if (kinds && isRecord(value)) {
      const index = kinds.indexOf(value.type as string);
      if (index === -1) return `"${path === "" ? "type" : `${path}.type`}" must be one of ${kinds.join(", ")}.`;
      return schemaProblem(schema.oneOf[index]!, value, path);
    }
    if (!schema.oneOf.some((candidate) => schemaProblem(candidate, value, path) === null)) return `${label} is not in a supported shape.`;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${label} must not be empty.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${label} must be at most ${schema.maxLength} characters.`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return `${label} is not in the expected format.`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${label} must be at least ${schema.minimum}.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${label} must be at most ${schema.maximum}.`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${label} needs at least ${schema.minItems} items.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${label} may have at most ${schema.maxItems} items.`;
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        const problem = schemaProblem(schema.items, value[index], `${path}[${index}]`);
        if (problem) return problem;
      }
    }
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) return `${label} needs at least ${schema.minProperties} entries.`;
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) return `${label} may have at most ${schema.maxProperties} entries.`;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${path === "" ? `"${key}"` : `"${path}.${key}"`} is required.`;
    }
    const properties = schema.properties ?? {};
    for (const key of keys) {
      const where = path === "" ? key : `${path}.${key}`;
      if (schema.propertyNames && !new RegExp(schema.propertyNames.pattern).test(key)) return `"${where}" is not an allowed name.`;
      if (Object.hasOwn(properties, key)) {
        const problem = schemaProblem(properties[key]!, value[key], where);
        if (problem) return problem;
      } else if (schema.additionalProperties === false) {
        return `"${where}" is not an argument this tool takes.`;
      } else if (isRecord(schema.additionalProperties)) {
        const problem = schemaProblem(schema.additionalProperties, value[key], where);
        if (problem) return problem;
      }
    }
  }
  return null;
}

export function toolNamed(name: unknown): McpToolDefinition | undefined {
  return typeof name === "string" ? TOOLS.find((tool) => tool.name === name) : undefined;
}

export function argumentProblem(tool: McpToolDefinition, args: unknown): string | null {
  if (!isRecord(args)) return "The arguments must be a JSON object.";
  return schemaProblem(tool.inputSchema, args);
}
