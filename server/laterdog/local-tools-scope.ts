export const LOCAL_TOOLS_HEADER = "x-laterdog-local-tools";
export const LOCAL_TOOLS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const SELF_APPROVAL_REFUSAL =
  "A dog must not be able to approve its own work, so this needs the desktop app or a paired device. Local tools can do everything else.";

interface RefusedRoute {
  methods: readonly string[];
  path: RegExp;
}

const ANY = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const WRITES = ["POST", "PUT", "PATCH", "DELETE"] as const;

export const LOCAL_TOOLS_REFUSED_ROUTES: readonly RefusedRoute[] = [
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { methods: ["POST", "PUT", "PATCH"], path: /^\/api\/bots\/[\w-]+\/command-allowlist(?:\/[\w-]+)?$/ },
  { methods: ANY, path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/[\w-]+$/ },
  { methods: ANY, path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/[\w-]+$/ },
  { methods: WRITES, path: /^\/api\/connectors\/[\w-]+(?:\/authorize|\/accounts\/[\w-]+)?$/ },
  { methods: WRITES, path: /^\/api\/auth\/pairing(?:\/[\w-]+)?$/ },
  { methods: WRITES, path: /^\/api\/desktop-viewer\// },
  { methods: WRITES, path: /^\/api\/desktop\/shared-computer-control$/ },
  { methods: WRITES, path: /^\/api\/instances(?:\/.*)?$/ },
  { methods: ["POST"], path: /^\/api\/cli-test$/ },
  { methods: WRITES, path: /^\/api\/mcp\/servers(?:\/.*)?$/ },
  { methods: ["POST"], path: /^\/api\/(?:teams\/import|org-library\/add|team-library\/github)$/ },
  { methods: ["POST"], path: /^\/api\/workspace-backup\/restore$/ },
];

export function localToolsRouteRefusal(method: string, path: string): string | null {
  const upper = method.toUpperCase();
  return LOCAL_TOOLS_REFUSED_ROUTES.some((rule) => rule.methods.includes(upper) && rule.path.test(path))
    ? SELF_APPROVAL_REFUSAL : null;
}

const GRANT_KEYS = [
  "acknowledgeLocalAuto", "refreshPermissions", "toolScope", "connectorScopes", "outbound",
  "mcpServers", "peers", "acknowledgePeerScope", "managedSections", "chiefOfStaff", "approvePeerComms",
  "computer", "browser", "composio",
] as const;
const CHANGE_ONLY_GRANT_KEYS = ["cwd"] as const;

const BOT_CREATE = /^\/api\/bots$/;
const BOT_CHANGE = /^\/api\/bots\/[\w-]+$/;
const TASK_CREATE = /^\/api\/bots\/[\w-]+\/tasks$/;
const TASK_CHANGE = /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/;
const CONFIG = /^\/api\/config$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const looserThanHeel = (body: Record<string, unknown>): boolean =>
  (body.approvalMode !== undefined && body.approvalMode !== "ask") || body.autoApprove === true;

const approvalFieldsNeedingOwner = (body: Record<string, unknown>): boolean =>
  looserThanHeel(body) || (Array.isArray(body.alwaysAllow) ? body.alwaysAllow.length > 0 : body.alwaysAllow !== undefined);

export function localToolsBodyRefusal(method: string, path: string, body: unknown): string | null {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS" || !isRecord(body)) return null;
  const refuse = SELF_APPROVAL_REFUSAL;
  const creatingDog = BOT_CREATE.test(path) && upper === "POST";
  const changingDog = BOT_CHANGE.test(path) && (upper === "PATCH" || upper === "PUT");
  if (creatingDog || changingDog) {
    if (approvalFieldsNeedingOwner(body)) return refuse;
    const keys = changingDog ? [...GRANT_KEYS, ...CHANGE_ONLY_GRANT_KEYS] : GRANT_KEYS;
    return keys.some((key) => body[key] !== undefined) ? refuse : null;
  }
  if (TASK_CREATE.test(path) && upper === "POST" || TASK_CHANGE.test(path) && (upper === "PATCH" || upper === "PUT")) {
    if (looserThanHeel(body) || body.acknowledgeLocalAuto !== undefined || body.refreshPermissions !== undefined) return refuse;
    if (Array.isArray(body.alwaysAllow) ? body.alwaysAllow.length > 0 : body.alwaysAllow !== undefined) return refuse;
    return null;
  }
  if (CONFIG.test(path) && (upper === "PUT" || upper === "PATCH")) {
    const defaults = isRecord(body.newBotDefaults) ? body.newBotDefaults : undefined;
    const profile = defaults && isRecord(defaults.profile) ? defaults.profile : undefined;
    if (profile && (looserThanHeel(profile) || approvalFieldsNeedingOwner(profile))) return refuse;
  }
  return null;
}
