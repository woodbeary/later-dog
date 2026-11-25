import { posix } from "node:path";
import { ALWAYS_ASK_IDS, type AlwaysAskId } from "../../shared/always-asks.ts";
import { actionTokens, isOutboundTool, type ConnectorCall } from "../../shared/outbound.ts";
import { COMPUTER_RUN_PATH } from "../routes/computer-run.ts";
import { isShell } from "./home-signals.ts";
import { apiCall, apiRefMove, codeLiterals, deletesOutsideWorkspace, isShellTool, shellSteps, type OwnerGuardContext, type ShellStep, type ShellWord } from "./owner-guard.ts";

export { ALWAYS_ASK_IDS, type AlwaysAskId };

export interface AlwaysAskRequest {
  tool: string;
  command?: string;
  summary?: string;
  input?: Record<string, unknown>;
}

export interface AlwaysAsk {
  id: AlwaysAskId;
  ask: string;
  refusal: string;
  decision?: "deny";
}

const WHAT: Record<AlwaysAskId, string> = {
  "push-skips-checks": "pushes code without running its checks",
  "cloud-credential": "makes a sign-in key or sign-in client in a cloud account",
  "delete-outside-workspace": "deletes files outside the dog's own folders",
  "sends-for-you": "sends or posts as you from a connected app",
  "pays": "pays or moves money from a connected app",
  "deletes-or-shares": "deletes something or changes who can reach it in a connected app",
};

const UNREADABLE = "This runs text later.dog cannot read, so it cannot tell whether it pushes code without running its checks.";
const THROUGH_API = "This creates or moves a branch through the API, so the code on it runs none of its checks.";

function found(id: AlwaysAskId, detail?: string): AlwaysAsk {
  return {
    id,
    ask: `${detail ?? `This ${WHAT[id]}.`} A dog always asks you before this, whatever its approval setting.`,
    refusal: `later.dog did not run this: it ${WHAT[id]}, and that always needs the person's yes. Ask them in the chat first.`,
  };
}

type Place = "home" | "own-computer" | "mac";

interface Seen {
  tool: string;
  shell?: string;
  place: Place;
  cwd?: string;
  page?: string;
  writes: string[];
  deletes: string[];
  input?: Record<string, unknown>;
}

const MAC_HOME = "/~";
const OPENS_PAGE = /open_url|navigate|open_page|goto|new_tab|open_tab/i;
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const bareName = (tool: string) => tool.replace(/^mcp__[^_]+__/, "");
const serverOf = (tool: string) => (tool.startsWith("mcp__") ? tool.split("__")[1] ?? "" : "");

function insideLentFolder(folderId: unknown, path: string): boolean {
  const written = path.trim().replace(/\/+$/, "");
  if (typeof folderId !== "string" || !folderId || /^[/~]|[\\:]/.test(written)) return false;
  const placed = posix.normalize(written);
  return placed !== "." && placed !== ".." && !placed.startsWith("../");
}

function seenOf(request: AlwaysAskRequest): Seen {
  const input = request.input ?? {};
  const name = bareName(request.tool);
  const server = serverOf(request.tool);
  const base: Seen = { tool: request.tool, place: "home", writes: [], deletes: [], ...(request.input ? { input: request.input } : {}) };
  if (isShellTool(request.tool)) return { ...base, shell: request.command ?? text(input.command) ?? request.summary };
  if ((server === "computer" && name === "exec") || name === "run_on_computer") {
    return { ...base, place: "own-computer", shell: text(input.command) ?? request.command ?? request.summary };
  }
  if (name === "shared_computer") {
    const path = text(input.path);
    const mac: Seen = { ...base, place: "mac", cwd: text(input.cwd) };
    if (input.action === "run_command") return { ...mac, shell: text(input.command) };
    if (input.action === "command_input") return { ...mac, shell: text(input.input) };
    if (input.action === "delete_file") return { ...mac, deletes: path && insideLentFolder(input.folder_id, path) ? [] : [path || "a file"] };
    if (input.action === "write_file" || input.action === "edit_file") return { ...mac, writes: path ? [path] : [] };
    return mac;
  }
  if (FILE_TOOLS.has(name)) {
    const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path) ?? request.summary?.split(/[\s:]/)[0];
    return { ...base, writes: path ? [path] : [] };
  }
  const url = text(input.url) ?? (OPENS_PAGE.test(name) ? request.summary : undefined);
  if (url && (OPENS_PAGE.test(name) || server === "browser" || server === "computer")) return { ...base, page: url };
  return base;
}

const NO_VERIFY = /^--no-veri(?:fy?)?$/;
const HOOK_PATH = /(?:^|\/)(?:\.git\/hooks|\.husky|\.githooks|githooks|git-hooks)(?:\/|$)/i;
const READABLE_SUBSTITUTION = /^\$\(git (?:branch --show-current|rev-parse --abbrev-ref HEAD)\)$/;
const WHOLE_VARIABLE = /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/;
const REMOTE_NAME = /^(?:origin|upstream|fork|github|gitlab)$/;
const DECODERS = new Set(["base64", "base32", "basenc", "xxd", "uudecode", "openssl", "gpg", "rev"]);
const SKIP_VARIABLE = /LATERDOG_SKIP_HOOKS=[^\s;&|)]|(?:export|declare|typeset|readonly|local)\s+(?:-\w+\s+)*LATERDOG_SKIP_HOOKS\b|LATERDOG_SKIP\w*\$|GIT_CONFIG_(?:KEY_\d+|PARAMETERS)=.*core\.hookspath/i;
const GIT_VALUE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path"]);
const DEPTH_LIMIT = 4;

type Skip = "plain" | "api" | "unreadable" | null;

const unreadable = (word: ShellWord | undefined) => word !== undefined && ((word.vars && !READABLE_SUBSTITUTION.test(word.text)) || word.glob);

const PROTECTED_BRANCH = /^(?:HEAD|main|master|trunk|develop|development|production|prod|release|stable)$/i;
const FORCE_OR_DELETE = /^(?:--force\S*|--delete|--mirror|--all|--prune|--tags|--follow-tags|-[a-zA-Z]*[fd][a-zA-Z]*)$/;
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec", "--signed"]);

function namesOnlyOtherBranches(args: readonly ShellWord[]): boolean {
  const operands: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (PUSH_VALUE_OPTIONS.has(word.text)) {
      i++;
      continue;
    }
    if (word.text.startsWith("-")) {
      if (FORCE_OR_DELETE.test(word.text)) return false;
      continue;
    }
    operands.push(word);
  }
  const [remote, ...refspecs] = operands;
  if (!remote || remote.vars || remote.glob || !refspecs.length) return false;
  return refspecs.every((spec) => {
    if (spec.vars || spec.glob || spec.text.startsWith("+") || /[*?[{]/.test(spec.text)) return false;
    const colon = spec.text.lastIndexOf(":");
    if (colon === 0) return false;
    const target = (colon === -1 ? spec.text : spec.text.slice(colon + 1)).replace(/^refs\/heads\//, "");
    return target !== "" && !target.startsWith("refs/") && !PROTECTED_BRANCH.test(target);
  });
}

function pushSkips(args: readonly ShellWord[], fromInput: boolean): Skip {
  if (fromInput) return "unreadable";
  const literals = args.filter((arg) => !arg.vars && !arg.text.startsWith("-"));
  let skipsChecks = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (WHOLE_VARIABLE.test(word.text)) {
      const after = literals.filter((arg) => args.indexOf(arg) > i);
      const beforeRemote = !literals.some((arg) => args.indexOf(arg) < i) && (after.length !== 1 || REMOTE_NAME.test(after[0]!.text));
      if (beforeRemote) return "unreadable";
      continue;
    }
    const refWord = word.vars && !word.glob && !word.bare && /^[^-$`]/.test(word.text) && literals.some((arg) => args.indexOf(arg) < i);
    if (unreadable(word) && !refWord) return "unreadable";
    if (NO_VERIFY.test(word.text)) skipsChecks = true;
    const option = word.text === "-o" || word.text === "--push-option" ? args[i + 1]?.text ?? "" : /^(?:-o|--push-option=)(.*)$/.exec(word.text)?.[1] ?? "";
    if (/ci\.skip|skip-checks/i.test(option)) skipsChecks = true;
  }
  return skipsChecks && !namesOnlyOtherBranches(args) ? "plain" : null;
}

function operandTexts(args: readonly ShellWord[]): string[] {
  return args.filter((arg) => !arg.text.startsWith("-") || arg.text === "-").map((arg) => arg.text);
}

function touchesHooks(step: ShellStep): boolean {
  const operands = operandTexts(step.args);
  const named = ["rm", "rmdir", "unlink", "shred", "trash", "chmod", "chown", "truncate", "mv"].includes(step.name) ? operands
    : ["cp", "install", "ln"].includes(step.name) ? operands.slice(-1)
      : step.name === "tee" ? operands
        : (step.name === "sed" || step.name === "perl") && step.args.some((arg) => /^-[a-zA-Z]*i|^--in-place/.test(arg.text)) ? operands
          : [];
  return [...named, ...step.writes].some((path) => HOOK_PATH.test(path));
}

function aliasSkips(value: string, depth: number): Skip {
  return value.startsWith("!") ? shellSkips(value.slice(1), depth + 1) : shellSkips(`git ${value}`, depth + 1);
}

function configSkips(args: readonly ShellWord[], depth: number): Skip {
  if (args.some((arg) => /^--(?:get|unset|list|show|name-only)|^-l$/.test(arg.text))) return null;
  const operands = operandTexts(args);
  if (operands[0] === "set") operands.shift();
  const [key = "", value] = operands;
  if (/^core\.hookspath=/i.test(key) || (/^core\.hookspath$/i.test(key) && value !== undefined)) return "plain";
  const alias = /^alias\.[^=]+(?:=(.*))?$/is.exec(key);
  if (alias) return aliasSkips(alias[1] ?? value ?? "", depth);
  return null;
}

function gitSkips(step: ShellStep, depth: number): Skip {
  const { args } = step;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word.text === "-c" || word.text === "--config-env" || word.text.startsWith("--config-env=")) {
      const value = word.text.startsWith("--config-env=") ? word.text.slice("--config-env=".length) : args[i + 1]?.text ?? "";
      if (!word.text.includes("=")) i++;
      if (unreadable(word.text.includes("=") ? word : args[i])) return "unreadable";
      if (/^core\.hookspath\b/i.test(value)) return "plain";
      const alias = /^alias\.[^=]+=(.*)$/is.exec(value);
      const nested = alias ? aliasSkips(alias[1]!, depth) : null;
      if (nested) return nested;
      continue;
    }
    if (GIT_VALUE_OPTIONS.has(word.text)) {
      i++;
      continue;
    }
    if (word.text.startsWith("-")) continue;
    if (unreadable(word)) return "unreadable";
    if (word.text === "send-pack") return "plain";
    if (word.text === "push") return pushSkips(args.slice(i + 1), step.input !== undefined);
    if (word.text === "config") return configSkips(args.slice(i + 1), depth);
    return null;
  }
  return null;
}

const CODE_APIS: readonly RegExp[] = [
  /api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/(?:git\/refs|contents\/)/,
  /\/api\/v4\/projects\/[^/\s]+\/repository\/(?:branches|commits|files\/|tags)/,
  /api\.bitbucket\.org\/2\.0\/repositories\/[^/\s]+\/[^/\s]+\/(?:refs\/(?:branches|tags)|src)/,
];
const GITLAB_WRITES = /^\/?projects\/[^/\s]+\/repository\/(?:branches|commits|files\/|tags)/;
const CONTENTS_PATH = /^\/?(?:api\/v3\/)?repos\/[^/\s]+\/[^/\s]+\/contents\//;

const GRAPHQL_MOVES = /\bmutation\b[\s\S]*\b(?:createRef|updateRef|updateRefs|createCommitOnBranch|mergeBranch)\b/;

function movesCodeByApi(step: ShellStep): boolean {
  if (step.name === "gh" || step.name === "glab") {
    const call = apiCall(step.args);
    if (!call || call.method === "GET") return false;
    if (step.name === "glab") return call.endpoints.some((endpoint) => GITLAB_WRITES.test(endpoint));
    if (call.endpoints.includes("graphql")) return GRAPHQL_MOVES.test(call.fields.query ?? "");
    return apiRefMove(call) !== null || (["PUT", "DELETE"].includes(call.method) && call.endpoints.some((endpoint) => CONTENTS_PATH.test(endpoint)));
  }
  return HTTP_CLIENTS.has(step.name) && mutates(step) && step.args.some((arg) => CODE_APIS.some((pattern) => pattern.test(pageText(arg.text))));
}

function stepSkips(step: ShellStep, depth: number, decodes: boolean): Skip {
  if (step.name !== "unset" && step.words.some((word) => SKIP_VARIABLE.test(word.text) || /^LATERDOG_SKIP_HOOKS$/.test(word.text) && step.name !== "echo")) return "plain";
  if (touchesHooks(step)) return "plain";
  if (movesCodeByApi(step)) return "api";
  if (step.name === "git") return gitSkips(step, depth);
  if (step.name === "git-send-pack") return "plain";
  if (step.name === "git-push") return pushSkips(step.args, step.input !== undefined);
  if (step.name === "alias") {
    for (const arg of step.args) {
      const value = /^[^=]+=(.*)$/s.exec(arg.text)?.[1];
      const nested = value ? shellSkips(value, depth + 1) : null;
      if (nested) return nested;
    }
  }
  if (step.args.some((arg) => arg.text === "push") && step.args.some((arg) => NO_VERIFY.test(arg.text))) return "plain";
  if (isShell(step.name) || step.name === "source" || step.name === ".") {
    const flag = step.args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg.text));
    if (decodes && flag !== -1 && unreadable(step.args[flag + 1])) return "unreadable";
    if (decodes && step.words.some((word) => word.text.startsWith("<"))) return "unreadable";
    const fed = step.piped && !["echo", "printf"].includes(step.piped.name);
    if (decodes && flag === -1 && !operandTexts(step.args).length && !step.here.length && fed) return "unreadable";
  }
  if (decodes && step.name === "eval" && step.args.some((arg) => arg.vars)) return "unreadable";
  return null;
}

function written(steps: readonly ShellStep[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const step of steps) {
    const content = step.name === "echo" || step.name === "printf" ? step.args.filter((arg) => !/^-[neE]+$/.test(arg.text)).map((arg) => arg.text).join(" ")
      : step.name === "cat" || step.name === "tee" ? step.here.join("\n")
        : undefined;
    if (content === undefined) continue;
    for (const file of [...step.writes, ...(step.name === "tee" ? operandTexts(step.args) : [])]) files.set(file, content.replace(/\\n/g, "\n"));
  }
  return files;
}

function runsWritten(step: ShellStep, files: Map<string, string>): string | undefined {
  const file = isShell(step.name) || step.name === "source" || step.name === "." ? operandTexts(step.args)[0] : step.name === "." ? undefined : step.words[0]?.text;
  if (!file) return undefined;
  return files.get(file) ?? files.get(file.replace(/^\.\//, "")) ?? files.get(`./${file}`);
}

function nestedSources(step: ShellStep, files: Map<string, string>): string[] {
  const fromFile = runsWritten(step, files);
  const fromCode = step.code === undefined ? [] : codeLiterals(step.code).filter((literal) => /\s/.test(literal));
  return [...(fromFile ? [fromFile] : []), ...fromCode];
}

function shellSkips(command: string, depth = 0): Skip {
  if (depth > DEPTH_LIMIT) return "unreadable";
  const steps = shellSteps(command, undefined, MAC_HOME, depth);
  const files = written(steps);
  const decodes = steps.some((step) => DECODERS.has(step.name) || (step.name === "xxd" && step.args.some((arg) => arg.text === "-r")));
  let result: Skip = null;
  for (const step of steps) {
    const skip = stepSkips(step, depth, decodes) ?? nestedSources(step, files).map((source) => shellSkips(source, depth + 1)).find(Boolean) ?? null;
    if (skip === "plain") return "plain";
    result ??= skip;
  }
  return result;
}

const CREDENTIAL_COMMANDS: readonly RegExp[] = [
  /(?<![\w-])gcloud\b.*\b(?:keys|api-keys|oauth-clients|oauth-brands|hmac|credentials|workload-identity-pools)\b.*\bcreate\b/,
  /(?<![\w-])aws\b.*\b(?:create-access-key|create-login-profile|update-login-profile|create-service-specific-credential|create-user-pool-client|create-api-key|create-key-pair)\b/,
  /(?<![\w-])az\s+ad\s+(?:app|sp)\b.*\b(?:credential|federated-credential|create-for-rbac|create)\b/,
  /(?<![\w-])gh\s+(?:ssh-key|gpg-key)\s+add\b/,
  /(?<![\w-])gh\s+api\b(?=.*\/?\buser\/(?:keys|gpg_keys|ssh_signing_keys)\b)(?=.*(?:\s-f\b|\s-F\b|--field|--raw-field|--input|\bpost\b))/,
  /(?<![\w-])(?:flyctl|fly)\b.*\btokens?\s+create\b/,
  /(?<![\w-])doctl\b.*\btokens?\s+create\b/,
];

const CREDENTIAL_APIS: readonly RegExp[] = [
  /api\.github\.com\/(?:user\/(?:keys|gpg_keys|ssh_signing_keys)|authorizations|app\/installations\/[^/\s]+\/access_tokens|repos\/[^/\s]+\/[^/\s]+\/keys)/,
  /api\.cloudflare\.com\/client\/v4\/(?:user|accounts\/[^/\s]+)\/tokens/,
  /api\.fly\.io\/\S*tokens|api\.machines\.dev\/\S*tokens/,
  /iam\.googleapis\.com\/\S*\/keys|apikeys\.googleapis\.com/,
  /iam\.amazonaws\.com\/?\S*createaccesskey/,
];

const CREDENTIAL_PAGES: readonly RegExp[] = [
  /console\.(?:cloud|developers)\.google\.com\/\S*(?:credentials|serviceaccounts|auth\/clients|auth\/branding|apikeys)/,
  /(?:myaccount|security)\.google\.com\/\S*apppasswords/,
  /console\.aws\.amazon\.com\/(?:iam|iamv2|cognito)/,
  /(?:portal\.azure\.com|entra\.microsoft\.com|aad\.portal\.azure\.com)\/\S*(?:registeredapps|applicationslistblade|applicationmenublade|credentials|certificates)/,
  /github\.com\/settings\/(?:tokens|personal-access-tokens|apps|developers|keys|ssh|gpg|applications\/new)/,
  /dash\.cloudflare\.com\/\S*api-tokens/,
  /fly\.io\/\S*tokens/,
  /developer\.apple\.com\/account\/resources\/authkeys/,
  /platform\.openai\.com\/\S*api-keys/,
  /console\.anthropic\.com\/settings\/keys/,
];

function pageText(raw: string): string {
  let out = raw.toLowerCase();
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

function opensCredentialPage(raw: string): boolean {
  const page = pageText(raw);
  return CREDENTIAL_PAGES.some((pattern) => pattern.test(page));
}

const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh", "xhs"]);

function mutates(step: ShellStep): boolean {
  return step.args.some((arg, index) => {
    const value = arg.text;
    if (/^(?:-X|--request|--method)$/.test(value)) return /^(?:post|put|patch)$/i.test(step.args[index + 1]?.text ?? "");
    if (/^(?:-X|--request=|--method=)(?:post|put|patch)$/i.test(value)) return true;
    if (/^(?:-d|--data\S*|-F|--form\S*|--json|-T|--upload-file|--post-data\S*|--post-file\S*)$/.test(value) || /^-d./.test(value)) return true;
    return (step.name === "http" || step.name === "https" || step.name.startsWith("xh")) && (/^(?:post|put|patch)$/i.test(value) || /^[\w.-]+:?=/.test(value));
  });
}

function stepMakesCredential(step: ShellStep): boolean {
  const line = [step.name, ...step.args.map((arg) => arg.text)].join(" ").toLowerCase();
  if (CREDENTIAL_COMMANDS.some((pattern) => pattern.test(line))) return true;
  if (step.words.some((word) => opensCredentialPage(word.text))) return true;
  return HTTP_CLIENTS.has(step.name) && mutates(step) && step.args.some((arg) => CREDENTIAL_APIS.some((pattern) => pattern.test(pageText(arg.text))));
}

function makesCredential(command: string, depth = 0): boolean {
  if (depth > DEPTH_LIMIT) return false;
  const steps = shellSteps(command, undefined, MAC_HOME, depth);
  const files = written(steps);
  return steps.some((step) => stepMakesCredential(step) || nestedSources(step, files).some((source) => makesCredential(source, depth + 1)));
}

const PAY_TOKENS = new Set(["PAY", "PAYS", "PAYOUT", "PAYMENT", "CHARGE", "REFUND", "TRANSFER", "INVOICE", "WITHDRAW", "WITHDRAWAL"]);
const REPOSITORY_APPS = new Set(["github", "gitlab", "bitbucket"]);
const POSTING_VERBS = new Set(["CREATE", "ADD", "NEW", "APPEND", "INSERT", "SCHEDULE"]);
const POSTED_NOUNS = new Set(["EVENT", "INVITATION", "MEETING", "PAGE", "ISSUE", "TASK", "TICKET", "CARD", "DOCUMENT", "DOC", "BLOCK", "BLOCKS", "CHILDREN"]);
const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

const STRONG_DESTROY_TOKENS = new Set(["DELETE", "DELETES", "TRASH", "REMOVE", "PURGE", "EMPTY", "DESTROY", "ERASE", "WIPE", "CLEAR"]);
const DESTROY_TOKENS = new Set([...STRONG_DESTROY_TOKENS, "ARCHIVE", "REPLACE", "OVERWRITE"]);
const REACH_TOKENS = new Set(["SHARE", "SHARING", "SHARED", "PERMISSION", "PERMISSIONS", "COLLABORATOR", "COLLABORATORS", "MEMBER", "MEMBERS", "INVITE",
  "ACCESS", "VISIBILITY", "PUBLIC", "PRIVATE", "OWNER", "OWNERSHIP", "ROLE", "ROLES", "REVOKE", "UNSHARE",
  "COLLABORATION", "COLLABORATIONS", "MEMBERSHIP", "MEMBERSHIPS", "ACL", "INVITATION", "INVITATIONS", "ADMIN", "SHARES", "GUEST", "GUESTS"]);
const READ_WORDS = new Set([...READ_VERBS, "VERIFY"]);
const WRITE_VERBS = new Set([...DESTROY_TOKENS, "ADD", "CREATE", "UPDATE", "SET", "PATCH", "INSERT", "MODIFY", "CHANGE", "MOVE", "TRANSFER", "GRANT",
  "ASSIGN", "MAKE", "CONVERT", "SHARE", "UNSHARE", "INVITE", "REVOKE", "ENABLE", "DISABLE", "APPROVE", "REJECT", "EDIT", "PUT", "POST", "UPSERT", "MERGE"]);

function readsByName(tokens: readonly string[]): boolean {
  if (tokens.some((token) => STRONG_DESTROY_TOKENS.has(token))) return false;
  const read = tokens.findIndex((token) => READ_WORDS.has(token));
  if (read === -1) return false;
  const write = tokens.findIndex((token) => WRITE_VERBS.has(token));
  return read === tokens.length - 1 || write === -1 || read < write;
}
const CONNECTOR_SLUG = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;
const COMPOSIO_SERVER = "mcp__composio__";

function connectorSlug(written: string): string | null {
  const tool = written.trim();
  if (tool.startsWith("mcp__") && !tool.startsWith(COMPOSIO_SERVER)) return null;
  const slug = (tool.startsWith(COMPOSIO_SERVER) ? tool.slice(COMPOSIO_SERVER.length) : tool).toUpperCase();
  return CONNECTOR_SLUG.test(slug) && !slug.startsWith("COMPOSIO_") ? slug : null;
}

function writingTokens(tool: string): string[] | null {
  const slug = connectorSlug(tool);
  const tokens = slug ? actionTokens(slug) : [];
  return tokens.length && (!READ_VERBS.has(tokens[0]!) || tokens.some((token) => STRONG_DESTROY_TOKENS.has(token))) ? tokens : null;
}

function deletesOrShares(tool: string): boolean {
  const tokens = writingTokens(tool);
  if (!tokens || readsByName(tokens)) return false;
  return tokens.some((token) => DESTROY_TOKENS.has(token) || REACH_TOKENS.has(token));
}

const keyWords = (key: string) => key.toLowerCase().replace(/[^a-z]/g, "");
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function labelsIn(value: unknown): string[] {
  return [value].flat(Infinity).flatMap((label) => (typeof label === "string" ? label.split(",") : []));
}

function addsTrashLabel(tool: string, args: unknown): boolean {
  const tokens = connectorSlug(tool)?.startsWith("GMAIL_") ? writingTokens(tool) : null;
  if (!tokens || !isRecord(args)) return false;
  const addsLabels = tokens.includes("ADD") || tokens.includes("MODIFY");
  return Object.entries(args).some(([key, value]) => (/add.*label|label.*add/.test(keyWords(key)) || (addsLabels && keyWords(key) === "labelids"))
    && labelsIn(value).some((label) => label.trim().toUpperCase() === "TRASH"));
}

const HARM_FLAGS = new Set(["trashed", "intrash", "archived", "closed"]);
const REACH_KEYS = new Set(["visibility", "private", "public", "role", "roles", "permission", "permissions", "permissionscheme", "accesslevel"]);
const turnedOn = (value: unknown) => value === true || (typeof value === "number" && value !== 0)
  || (typeof value === "string" && !["", "false", "0", "no", "off"].includes(value.trim().toLowerCase()));
const given = (value: unknown) => value !== undefined && value !== null && value !== "";

function argumentsDeleteOrShare(tool: string, args: unknown): boolean {
  const tokens = writingTokens(tool);
  if (!tokens || readsByName(tokens) || !isRecord(args)) return false;
  if (tokens.some((token) => HARM_FLAGS.has(token.toLowerCase())) && turnedOn(args.value)) return true;
  return Object.entries(args).some(([key, value]) => (HARM_FLAGS.has(keyWords(key)) && turnedOn(value)) || (REACH_KEYS.has(keyWords(key)) && given(value)));
}

function callDeletesOrShares(tool: string, args: unknown): boolean {
  return deletesOrShares(tool) || addsTrashLabel(tool, args) || argumentsDeleteOrShare(tool, args);
}

function appOf(tool: string): string {
  if (tool.startsWith("mcp__")) return serverOf(tool).toLowerCase();
  return /^[A-Z][A-Z0-9]*_/.test(tool) ? tool.slice(0, tool.indexOf("_")).toLowerCase() : "";
}

function actsAsYou(tool: string): AlwaysAskId | null {
  const tokens = actionTokens(tool);
  if (!tokens.length || READ_VERBS.has(tokens[0]!)) return null;
  const posts = tokens.some((token) => POSTING_VERBS.has(token)) && tokens.some((token) => POSTED_NOUNS.has(token));
  if (!isOutboundTool(tool) && !posts) return null;
  if (tokens.some((token) => PAY_TOKENS.has(token))) return "pays";
  return REPOSITORY_APPS.has(appOf(tool)) ? null : "sends-for-you";
}

export function connectorAlwaysAsks(calls: readonly (string | ConnectorCall)[], ownerFull = false): AlwaysAsk | null {
  const each = calls.map((call) => (typeof call === "string" ? { slug: call } : call));
  const ids = each.map((call) => actsAsYou(call.slug));
  if (ids.includes("pays")) return found("pays");
  if (ids.includes("sends-for-you")) return found("sends-for-you");
  return !ownerFull && each.some((call) => callDeletesOrShares(call.slug, call.arguments)) ? found("deletes-or-shares") : null;
}

function macGuard(cwd: string | undefined): OwnerGuardContext {
  return {
    cwd: cwd === undefined ? undefined : cwd.startsWith("/") ? cwd : `${MAC_HOME}/${cwd.replace(/^~\/?/, "")}`,
    workspaceRoots: [],
    scratch: true,
    tempRoots: ["/tmp", "/private/tmp", "/private/var/folders", "/var/folders"],
    home: MAC_HOME,
  };
}

type Rule = (seen: Seen, guard: () => OwnerGuardContext) => string | boolean;

const RULES: Record<AlwaysAskId, Rule> = {
  "push-skips-checks": ({ shell, writes }) => {
    if (writes.some((path) => HOOK_PATH.test(path))) return true;
    const skip = shell === undefined ? null : shellSkips(shell);
    return skip === "unreadable" ? UNREADABLE : skip === "api" ? THROUGH_API : skip === "plain";
  },
  "cloud-credential": ({ shell, page }) => (shell !== undefined && makesCredential(shell)) || (page !== undefined && opensCredentialPage(page)),
  "delete-outside-workspace": ({ shell, place, deletes }, guard) => {
    if (place === "own-computer") return false;
    if (deletes.length) return `This deletes ${deletes.join(", ")} on your Mac.`;
    const refusal = shell !== undefined ? deletesOutsideWorkspace(shell, guard()) : null;
    return refusal?.ask ?? refusal?.message ?? false;
  },
  "sends-for-you": ({ tool }) => actsAsYou(tool) === "sends-for-you",
  "pays": ({ tool }) => actsAsYou(tool) === "pays",
  "deletes-or-shares": ({ tool, input }) => callDeletesOrShares(tool, input),
};

export function alwaysAsks(request: AlwaysAskRequest, guard: () => OwnerGuardContext): AlwaysAsk | null {
  const seen = seenOf(request);
  const context = guard();
  const guardFor = () => (seen.place === "mac" ? { ...macGuard(seen.cwd), ownerFull: context.ownerFull } : context);
  for (const id of ALWAYS_ASK_IDS) {
    if (context.ownerFull && (id === "cloud-credential" || id === "deletes-or-shares")) continue;
    const hit = RULES[id](seen, guardFor);
    if (!hit) continue;
    if (context.ownerFull && (id === "delete-outside-workspace" || id === "push-skips-checks")) {
      const refusal = id === "delete-outside-workspace" && seen.shell !== undefined
        ? deletesOutsideWorkspace(seen.shell, guardFor())?.message
        : undefined;
      return {
        ...found(id),
        decision: "deny",
        refusal: refusal ?? (id === "push-skips-checks"
          ? "later.dog refused this: it bypasses the repository's checks. Run the checks and push without bypassing them."
          : "later.dog refused this: the delete target is outside the dog's own folders. Write a literal path inside a lent folder or the dog's scratch folder."),
      };
    }
    return found(id, typeof hit === "string" ? hit : undefined);
  }
  return null;
}

export function alwaysAskHook(payload: Record<string, unknown>, guard: () => OwnerGuardContext): Record<string, unknown> | null {
  const tool = text(payload.tool_name);
  const input = payload.tool_input && typeof payload.tool_input === "object" ? (payload.tool_input as Record<string, unknown>) : undefined;
  if (!tool || !input) return null;
  const hit = alwaysAsks({ tool, input }, guard);
  return hit ? { hookEventName: "PreToolUse", permissionDecision: hit.decision ?? "ask", permissionDecisionReason: hit.decision === "deny" ? hit.refusal : hit.ask } : null;
}

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const ALWAYS_ASK_PATHS = new Set(["/api/internal/computer/mcp", "/api/internal/browser/mcp", "/api/internal/shared-computers", COMPUTER_RUN_PATH]);

export function internalCallRequest(path: string, body: unknown): AlwaysAskRequest | null {
  const call = objectOf(body);
  if (path === COMPUTER_RUN_PATH) return { tool: "mcp__agents__run_on_computer", input: call };
  if (path === "/api/internal/shared-computers") return { tool: "mcp__agents__shared_computer", input: call };
  if (call.method !== "tools/call") return null;
  const params = objectOf(call.params);
  const name = text(params.name);
  if (!name) return null;
  const server = path === "/api/internal/computer/mcp" ? "computer" : path === "/api/internal/browser/mcp" ? "browser" : null;
  return server ? { tool: `mcp__${server}__${name}`, input: objectOf(params.arguments) } : null;
}

export function asksAsConnector(slug: string, args?: unknown): boolean {
  return isOutboundTool(slug) || actsAsYou(slug) !== null || callDeletesOrShares(slug, args);
}
