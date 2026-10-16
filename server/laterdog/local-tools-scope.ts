export const LOCAL_TOOLS_HEADER = "x-laterdog-local-tools";
export const LOCAL_TOOLS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const LOCAL_TOOLS_REFUSAL =
  "A dog must not be able to approve its own work, so local tools may only do what the later.dog scripts do: send messages, make and change dogs, rooms and threads, switch models, edit a message and stop a conversation. Anything else needs the desktop app or a paired device.";

type Shape = (value: unknown) => boolean;

interface AllowedRoute {
  methods: readonly string[];
  path: RegExp;
  keys: Readonly<Record<string, Shape>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text: Shape = (value) => typeof value === "string" && value.length <= 200_000;
const flag: Shape = (value) => typeof value === "boolean";
const strings: Shape = (value) => Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === "string" && item.length <= 200);

function exactly(allowed: Readonly<Record<string, Shape>>): Shape {
  return (value) => isRecord(value) && Object.entries(value).every(([key, item]) => Object.hasOwn(allowed, key) && allowed[key]!(item));
}

const modelSelection = exactly({ instanceId: text, model: text, effort: text, variant: text, fast: flag });
const responder = exactly({ kind: text, botId: text });
const roomSetup = exactly({ bulletin: text, defaultResponder: responder });

const SEND = { text, threadId: text } as const;
const NO_BODY = {} as const;

export const LOCAL_TOOLS_ALLOWED_ROUTES: readonly AllowedRoute[] = [
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages$/, keys: SEND },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/messages$/, keys: SEND },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/, keys: SEND },
  { methods: ["POST"], path: /^\/api\/(?:bots|groups)\/[\w-]+\/interrupt$/, keys: { threadId: text } },
  { methods: ["POST"], path: /^\/api\/bots$/, keys: { name: text, title: text, description: text, modelSelection, requireAvailableModel: flag } },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+$/, keys: { name: text, title: text, description: text, modelSelection, requireAvailableModel: flag } },
  { methods: ["POST"], path: /^\/api\/groups$/, keys: { name: text, memberIds: strings, setup: roomSetup } },
  { methods: ["PATCH"], path: /^\/api\/groups\/[\w-]+$/, keys: { name: text, memberIds: strings, bulletin: text, defaultResponder: responder } },
  { methods: ["POST"], path: /^\/api\/(?:bots|groups)\/[\w-]+\/tasks$/, keys: { title: text } },
  { methods: ["POST"], path: /^\/api\/(?:bots|groups)\/[\w-]+\/tasks\/[\w-]+$/, keys: NO_BODY },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/, keys: { title: text, modelSelection, requireAvailableModel: flag } },
  { methods: ["PATCH"], path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/, keys: { title: text } },
];

function allowedRoute(method: string, path: string): AllowedRoute | undefined {
  const upper = method.toUpperCase();
  return LOCAL_TOOLS_ALLOWED_ROUTES.find((rule) => rule.methods.includes(upper) && rule.path.test(path));
}

export function signsItselfOut(method: string, path: string): boolean {
  return method === "POST" && path === "/api/auth/logout";
}

export function localToolsRouteRefusal(method: string, path: string): string | null {
  return allowedRoute(method, path) ? null : LOCAL_TOOLS_REFUSAL;
}

export function localToolsBodyRefusal(method: string, path: string, body: unknown): string | null {
  const rule = allowedRoute(method, path);
  if (!rule) return LOCAL_TOOLS_REFUSAL;
  const supplied = body === undefined ? {} : body;
  return exactly(rule.keys)(supplied) ? null : LOCAL_TOOLS_REFUSAL;
}

export interface TypedMessageSource {
  fromLocalTools: boolean;
  session: boolean;
  desktopManaged: boolean;
}

export function typedMessageAuthority<Answerer>(
  source: TypedMessageSource,
  answerer: () => Answerer,
): { personPresent: boolean; via?: "api"; answerer?: Answerer } {
  if (source.fromLocalTools) return { personPresent: false, via: "api" };
  return { personPresent: source.session || source.desktopManaged, answerer: answerer() };
}
