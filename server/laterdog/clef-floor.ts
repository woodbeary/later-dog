import { resolve, sep } from "node:path";

import type { ReviewField } from "../../shared/review-input.ts";

export interface ReviewScope {
  cwd?: string;
  projectRoot?: string;
  protectedPaths?: readonly string[];
}

export type FloorReason =
  | "shell_operator"
  | "parent_path"
  | "home_path"
  | "outside_project"
  | "credential_path"
  | "laterdog_data";

const SHELL_TOOL = /bash|shell|exec|terminal|powershell|run_command/i;
const COMMAND_KEY = /^(command|cmd|script|args|argv|commandline|shell|code)$/i;
const PROSE_KEY = /^(description|timeout|run_in_background|reason|title|justification|message)$/i;
const PATH_KEY = /(path|file|name|dir|folder|cwd|target|dest|src|source|location|root|url|uri|glob)s?$/i;

const OPERATORS = /[;&|`<>\n\r\0]|\$[A-Za-z_{(]/;
const PARENT_SEGMENT = /(^|[/\\\s"'=:(])\.\.([/\\\s"')]|$)/;
const HOME = /(^|[\s"'=:(])~|\$HOME|%USERPROFILE%/;
const ABSOLUTE_TOKEN = /(?<![\w.~:/-])\/(?!\/)[^\s"'`;|&<>()]*/g;
const FILE_URL = /^file:\/\//i;
const WEB_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

const CREDENTIALS: readonly RegExp[] = [
  /(^|[/\\\s"'=:])\.(ssh|aws|gnupg|kube|docker|azure|npm|gem)([/\\\s"']|$)/i,
  /(^|[/\\\s"'=:])\.env(\.[\w.-]+)?([\s"'/\\;|&]|$)/i,
  /\.(npmrc|netrc|pypirc|git-credentials|pgpass)\b/i,
  /(^|[/\\\s"'=:])id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|p12|pfx|keystore|jks)\b/i,
  /keychain/i,
  /credentials\.(json|bin)\b/i,
];

const LATERDOG_DATA = /(^|[/\\\s"'=:])\.laterdog([/\\\s"']|$)|credentials\.bin\b/i;

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function pathProblems(value: string, scope: ReviewScope): FloorReason | null {
  const url = WEB_URL.test(value.trim()) && !FILE_URL.test(value.trim());
  if (!url && PARENT_SEGMENT.test(value)) return "parent_path";
  if (!url && HOME.test(value)) return "home_path";
  if (LATERDOG_DATA.test(value)) return "laterdog_data";
  if (CREDENTIALS.some((pattern) => pattern.test(value))) return "credential_path";
  const root = scope.projectRoot ? resolve(scope.projectRoot) : undefined;
  const protectedPaths = (scope.protectedPaths ?? [])
    .filter(Boolean)
    .map((path) => resolve(path))
    .filter((path) => !(root && within(root, path)));
  if (protectedPaths.some((path) => value.includes(path))) return "laterdog_data";
  if (url) return null;
  const candidates = FILE_URL.test(value.trim())
    ? [value.trim().replace(FILE_URL, "")]
    : [...value.matchAll(ABSOLUTE_TOKEN)].map((match) => match[0]);
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (!root || !within(absolute, root)) return "outside_project";
  }
  return null;
}

export function reviewFloor(input: { tool: string; fields: readonly ReviewField[]; hasCommand?: boolean }, scope: ReviewScope): FloorReason | null {
  const shellTool = input.hasCommand === true || SHELL_TOOL.test(input.tool);
  for (const { key, value } of input.fields) {
    const commandLike = COMMAND_KEY.test(key) || (shellTool && !PROSE_KEY.test(key) && !PATH_KEY.test(key));
    const pathLike = commandLike || PATH_KEY.test(key);
    if (commandLike && OPERATORS.test(value)) return "shell_operator";
    if (pathLike) {
      const problem = pathProblems(value, scope);
      if (problem) return problem;
    }
  }
  return null;
}
