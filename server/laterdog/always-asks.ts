import { ALWAYS_ASK_IDS, type AlwaysAskId } from "../../shared/always-asks.ts";
import { actionTokens, isOutboundTool } from "../../shared/outbound.ts";
import { deletesOutsideWorkspace, isShellTool, type OwnerGuardContext } from "./owner-guard.ts";

export { ALWAYS_ASK_IDS, type AlwaysAskId };

export interface AlwaysAskRequest {
  tool: string;
  command?: string;
  summary?: string;
}

export interface AlwaysAsk {
  id: AlwaysAskId;
  ask: string;
  refusal: string;
}

const WHAT: Record<AlwaysAskId, string> = {
  "push-skips-checks": "pushes code without running its checks",
  "cloud-credential": "makes a sign-in key or sign-in client in a cloud account",
  "delete-outside-workspace": "deletes files outside the dog's own folders",
  "sends-for-you": "sends or posts as you from a connected app",
  "pays": "pays or moves money from a connected app",
};

function found(id: AlwaysAskId, detail?: string): AlwaysAsk {
  return {
    id,
    ask: `${detail ?? `This ${WHAT[id]}.`} A dog always asks you before this, whatever its approval setting.`,
    refusal: `later.dog did not run this: it ${WHAT[id]}, and that always needs the person's yes. Ask them in the chat first.`,
  };
}

const ASSIGNED = /(?<![\w$])([A-Za-z_]\w*)=([^\s;&|)`]*)/g;
const PRINTED = /\$\((?:echo|printf)(?:\s+-[a-zA-Z-]*)*\s+([^()`]*?)\s*\)|`(?:echo|printf)(?:\s+-[a-zA-Z-]*)*\s+([^`]*?)\s*`/g;

function expanded(text: string): string {
  let out = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const values = new Map<string, string>();
    for (const [, name, value] of out.matchAll(ASSIGNED)) values.set(name!, value!);
    const next = out
      .replace(PRINTED, (_match, inner?: string, ticked?: string) => (inner ?? ticked ?? "").replace(/%s/g, ""))
      .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (match, braced?: string, bare?: string) => values.get((braced ?? bare)!) ?? match);
    if (next === out) break;
    out = next;
  }
  return out;
}

export function plainShell(command: string): string {
  const unquoted = command
    .replace(/\\\r?\n/g, "")
    .replace(/\$(?=['"])/g, "")
    .replace(/["'\\]/g, "");
  return expanded(unquoted).replace(/[{}]/g, "");
}

const PUSHES = /(?<![\w.-])(?:push|send-pack)(?![\w-])/;
const NO_VERIFY = /no-veri/i;
const SKIP_VARIABLE = /LATERDOG_SKIP_HOOKS/g;
const HOOKS_PATH = /core\.hookspath/i;
const HOOKS_PATH_READ = /(?:--get(?:-all|-regexp)?|--unset(?:-all)?|--list|(?<![\w-])-l)(?![\w-])|^\s*(?:\S*\/)?git\s+config\s+(?:--(?:global|local|system|worktree)\s+)?core\.hookspath\s*$/i;
const HOOK_FILE_CHANGE = /(?:(?<![\w-])(?:rm|mv|chmod|truncate|cp|ln|unlink|sed|tee)(?![\w-])[^;&|\n]*hooks\/pre-(?:push|commit))|(?:>\s*\S*hooks\/pre-(?:push|commit))/;
const CI_SKIP = /ci\.skip|skip-checks:\s*true/i;
const DECODES = /(?<![\w-])(?:base64|xxd|rev|openssl\s+enc)(?![\w-])|\\x[0-9a-f]{2}|\\[0-7]{3}/i;
const SEND_PACK = /(?<![\w-])send-pack(?![\w-])/;

function setsSkipVariable(text: string): boolean {
  for (const match of text.matchAll(SKIP_VARIABLE)) {
    const before = text.slice(0, match.index);
    if (before.endsWith("$")) continue;
    if (/(?:(?<![\w-])unset|(?<![\w-])-u|--unset)\s+$/.test(before)) continue;
    return true;
  }
  return false;
}

function changesHooksPath(text: string): boolean {
  return text.split(/[;&|\n]/).some((segment) => HOOKS_PATH.test(segment) && !HOOKS_PATH_READ.test(segment));
}

function skipsChecks(command: string): boolean {
  const text = plainShell(command);
  if (setsSkipVariable(text) || changesHooksPath(text) || HOOK_FILE_CHANGE.test(text) || SEND_PACK.test(text)) return true;
  if (!PUSHES.test(text)) return false;
  return NO_VERIFY.test(text) || CI_SKIP.test(text) || DECODES.test(command);
}

const CREDENTIAL_COMMANDS: readonly RegExp[] = [
  /(?<![\w-])gcloud(?![\w-])[^;&|\n]*(?<![\w-])(?:keys|api-keys|oauth-clients|oauth-brands|hmac|credentials|workload-identity-pools)(?![\w-])[^;&|\n]*(?<![\w-])create(?![\w-])/,
  /(?<![\w-])aws(?![\w-])[^;&|\n]*(?<![\w-])(?:create-access-key|create-login-profile|update-login-profile|create-service-specific-credential|create-user-pool-client|create-api-key|create-key-pair)(?![\w-])/,
  /(?<![\w-])az\s+ad\s+(?:app|sp)(?![\w-])[^;&|\n]*(?<![\w-])(?:credential|federated-credential|create-for-rbac|create)(?![\w-])/,
  /(?<![\w-])gh\s+(?:ssh-key|gpg-key)\s+add(?![\w-])/,
  /(?<![\w-])gh\s+api(?![\w-])[^;&|\n]*(?<![\w-])\/?user\/(?:keys|gpg_keys|ssh_signing_keys)(?![\w-])[^;&|\n]*(?:-f|-F|--field|--raw-field|--input|post)(?![\w-])/,
  /(?<![\w-])gh\s+api(?![\w-])[^;&|\n]*(?:-f|-F|--field|--raw-field|--input|post)(?![\w-])[^;&|\n]*(?<![\w-])\/?user\/(?:keys|gpg_keys|ssh_signing_keys)(?![\w-])/,
];

const CREDENTIAL_PAGES: readonly RegExp[] = [
  /console\.(?:cloud|developers)\.google\.com\/\S*(?:credentials|serviceaccounts|auth\/clients|auth\/branding|apikeys)/,
  /console\.aws\.amazon\.com\/(?:iam|iamv2|cognito)/,
  /(?:portal\.azure\.com|entra\.microsoft\.com|aad\.portal\.azure\.com)\/\S*(?:registeredapps|applicationslistblade|applicationmenublade|credentials|certificates)/,
  /github\.com\/settings\/(?:tokens|personal-access-tokens|apps|developers|keys|ssh|gpg|applications\/new)/,
  /dash\.cloudflare\.com\/\S*api-tokens/,
  /developer\.apple\.com\/account\/resources\/authkeys/,
  /platform\.openai\.com\/\S*api-keys/,
  /console\.anthropic\.com\/settings\/keys/,
];

const OPENS_PAGE = /open_url|navigate|open_page|goto|new_tab|open_tab/i;

function pageText(text: string): string {
  let out = text.toLowerCase();
  for (let pass = 0; pass < 3; pass += 1) {
    let next = out;
    try {
      next = decodeURIComponent(out);
    } catch {
      next = out.replace(/%([0-9a-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (next === out) break;
    out = next.toLowerCase();
  }
  return out.replace(/\/{2,}/g, "/").replace(/:\/(?=\S)/g, "://");
}

function opensCredentialPage(text: string): boolean {
  const page = pageText(plainShell(text));
  return CREDENTIAL_PAGES.some((pattern) => pattern.test(page));
}

function makesCredential(command: string): boolean {
  const text = plainShell(command).toLowerCase();
  return CREDENTIAL_COMMANDS.some((pattern) => pattern.test(text)) || opensCredentialPage(command);
}

const PAY_TOKENS = new Set(["PAY", "PAYS", "PAYOUT", "PAYMENT", "CHARGE", "REFUND", "TRANSFER", "INVOICE", "WITHDRAW", "WITHDRAWAL"]);

const REPOSITORY_APPS = new Set(["github", "gitlab", "bitbucket"]);

function appOf(tool: string): string {
  if (tool.startsWith("mcp__")) return (tool.split("__")[1] ?? "").toLowerCase();
  return /^[A-Z][A-Z0-9]*_/.test(tool) ? tool.slice(0, tool.indexOf("_")).toLowerCase() : "";
}

function actsAsYou(tool: string): AlwaysAskId | null {
  if (!isOutboundTool(tool)) return null;
  if (actionTokens(tool).some((token) => PAY_TOKENS.has(token))) return "pays";
  return REPOSITORY_APPS.has(appOf(tool)) ? null : "sends-for-you";
}

export function connectorAlwaysAsks(slugs: readonly string[]): AlwaysAsk | null {
  const ids = slugs.map(actsAsYou);
  if (ids.includes("pays")) return found("pays");
  return ids.includes("sends-for-you") ? found("sends-for-you") : null;
}

interface Seen {
  tool: string;
  shell: string | undefined;
  page: string | undefined;
}

type Rule = (seen: Seen, guard: () => OwnerGuardContext) => string | boolean;

const RULES: Record<AlwaysAskId, Rule> = {
  "push-skips-checks": ({ shell }) => shell !== undefined && skipsChecks(shell),
  "cloud-credential": ({ shell, page }) => (shell !== undefined && makesCredential(shell)) || (page !== undefined && opensCredentialPage(page)),
  "delete-outside-workspace": ({ shell }, guard) => (shell !== undefined && deletesOutsideWorkspace(shell, guard())?.ask) || false,
  "sends-for-you": ({ tool }) => actsAsYou(tool) === "sends-for-you",
  "pays": ({ tool }) => actsAsYou(tool) === "pays",
};

export function alwaysAsks(request: AlwaysAskRequest, guard: () => OwnerGuardContext): AlwaysAsk | null {
  const shellTool = isShellTool(request.tool);
  const seen: Seen = {
    tool: request.tool,
    shell: shellTool ? request.command ?? request.summary : undefined,
    page: !shellTool && OPENS_PAGE.test(request.tool.replace(/^mcp__[^_]+__/, "")) ? request.summary : undefined,
  };
  for (const id of ALWAYS_ASK_IDS) {
    const hit = RULES[id](seen, guard);
    if (hit) return found(id, typeof hit === "string" ? hit : undefined);
  }
  return null;
}

export function alwaysAskHook(payload: Record<string, unknown>, guard: () => OwnerGuardContext): Record<string, unknown> | null {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = payload.tool_input && typeof payload.tool_input === "object" ? (payload.tool_input as Record<string, unknown>) : {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const url = typeof input.url === "string" ? input.url : undefined;
  if (!tool || (command === undefined && url === undefined)) return null;
  const hit = alwaysAsks({ tool, command, summary: url }, guard);
  return hit ? { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: hit.ask } : null;
}
