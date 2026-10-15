import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export type OwnerGuardRule = "force-push-default-branch" | "delete-remote-repository" | "delete-outside-workspace";

export interface OwnerGuardRefusal {
  rule: OwnerGuardRule;
  message: string;
}

export interface GitLookup {
  currentBranch(dir: string): Promise<string | null>;
  defaultBranch(dir: string, remote: string): Promise<string | null>;
}

export interface OwnerGuardContext {
  cwd: string | undefined;
  workspaceRoots: readonly string[];
  tempRoots?: readonly string[];
  home?: string;
  git?: GitLookup;
}

export interface OwnerGuardRequest {
  tool: string;
  command?: string;
}

interface Word {
  text: string;
  glob: boolean;
  vars: boolean;
}

type Piece = { word: Word } | { op: string };

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "nohup", "time", "nice", "doas"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);
const PUSH_VALUE_OPTIONS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
const GH_API_VALUE_OPTIONS = new Set([
  "-X", "--method", "-H", "--header", "-f", "--field", "-F", "--raw-field", "--input", "-q", "--jq", "-t", "--template",
  "--hostname", "--cache", "-p", "--preview",
]);
const REPO_PATH = /^\/?(?:api\/v3\/)?repos\/[^/\s?#]+\/[^/\s?#]+\/?$/;
const DEPTH_LIMIT = 4;

function tokenize(source: string): Piece[] {
  const pieces: Piece[] = [];
  let text = "";
  let glob = false;
  let vars = false;
  let started = false;
  const flush = () => {
    if (started) pieces.push({ word: { text, glob, vars } });
    text = "";
    glob = false;
    vars = false;
    started = false;
  };
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "<" && source[i + 1] === "<" && source[i + 2] !== "<" && !started) {
      const opener = /^<<(-?)\s*(['"]?)([^\s'"<>;&|()]+)\2/.exec(source.slice(i));
      if (opener) {
        heredocs.push({ delimiter: opener[3]!, tabs: opener[1] === "-" });
        i += opener[0].length;
        continue;
      }
    }
    if (ch === "\n" && heredocs.length) {
      flush();
      pieces.push({ op: ";" });
      let at = i + 1;
      for (const { delimiter, tabs } of heredocs.splice(0)) {
        for (;;) {
          const end = source.indexOf("\n", at);
          const line = source.slice(at, end === -1 ? source.length : end);
          at = end === -1 ? source.length : end + 1;
          if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter || end === -1) break;
        }
      }
      i = at;
      continue;
    }
    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      const stop = end === -1 ? source.length : end;
      text += source.slice(i + 1, stop);
      started = true;
      i = stop + 1;
      continue;
    }
    if (ch === "\"") {
      started = true;
      i++;
      while (i < source.length && source[i] !== "\"") {
        if (source[i] === "\\" && i + 1 < source.length && "\"\\$`".includes(source[i + 1]!)) {
          text += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === "$" || source[i] === "`") vars = true;
        text += source[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < source.length && source[i + 1] !== "\n") text += source[i + 1];
      started = started || source[i + 1] !== "\n";
      i += 2;
      continue;
    }
    if (ch === "$" && source[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < source.length; j++) {
        if (source[j] === "(") depth++;
        else if (source[j] === ")" && --depth === 0) break;
      }
      text += source.slice(i, j + 1);
      vars = true;
      started = true;
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      const stop = end === -1 ? source.length : end;
      text += source.slice(i, stop + 1);
      vars = true;
      started = true;
      i = stop + 1;
      continue;
    }
    if (ch === "#" && !started) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      i++;
      continue;
    }
    const redirectAmpersand = ch === "&" && (source[i - 1] === ">" || source[i - 1] === "<" || source[i + 1] === ">");
    if (!redirectAmpersand && (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")")) {
      flush();
      const pair = source.slice(i, i + 2);
      const op = pair === "&&" || pair === "||" || pair === ";;" || pair === "|&" ? pair : ch === "\n" ? ";" : ch;
      pieces.push({ op });
      i += op.length;
      continue;
    }
    if (ch === "$") vars = true;
    if (ch === "*" || ch === "?" || ch === "[") glob = true;
    text += ch;
    started = true;
    i++;
  }
  flush();
  return pieces;
}

function segments(source: string): { words: Word[]; after: string | undefined }[] {
  const out: { words: Word[]; after: string | undefined }[] = [];
  let current: Word[] = [];
  for (const piece of tokenize(source)) {
    if ("op" in piece) {
      out.push({ words: current, after: piece.op });
      current = [];
    } else current.push(piece.word);
  }
  out.push({ words: current, after: undefined });
  return out.filter((segment) => segment.words.length > 0);
}

function withoutRedirects(words: Word[]): Word[] {
  const kept: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const text = words[i]!.text;
    if (/^\d*(?:>>?|<<?<?|&>>?|>&|<&|>\|)$/.test(text)) {
      i++;
      continue;
    }
    if (/^\d*(?:>>?|<|&>>?|>&|<&)./.test(text)) continue;
    kept.push(words[i]!);
  }
  return kept;
}

function commandWords(words: Word[]): Word[] {
  let rest = withoutRedirects(words);
  for (;;) {
    const head = rest[0];
    if (!head) return rest;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head.text) || head.text === "{" || head.text === "!") {
      rest = rest.slice(1);
      continue;
    }
    const name = basename(head.text);
    if (WRAPPERS.has(name)) {
      rest = rest.slice(1);
      while (rest[0]?.text.startsWith("-")) rest = rest.slice(rest[0].text === "-u" ? 2 : 1);
      continue;
    }
    if (name === "env") {
      rest = rest.slice(1);
      while (rest[0] && (rest[0].text.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].text))) rest = rest.slice(1);
      continue;
    }
    if (name === "timeout") {
      rest = rest.slice(1);
      while (rest[0]?.text.startsWith("-")) rest = rest.slice(1);
      rest = rest.slice(1);
      continue;
    }
    return rest;
  }
}

interface Paths {
  home: string;
  temp: string[];
  roots: string[];
}

function within(path: string, root: string, allowEqual: boolean): boolean {
  const rel = relative(root, path);
  if (rel === "") return allowEqual;
  return !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

function expandWord(word: Word, cwd: string | undefined, paths: Paths): string | null {
  let text = word.text;
  if (text === "~" || text.startsWith("~/")) text = paths.home + text.slice(1);
  if (word.vars) {
    text = text.replace(/\$\{?(HOME|TMPDIR|PWD)\}?/g, (_match, name: string) =>
      name === "HOME" ? paths.home : name === "TMPDIR" ? tmpdir() : (cwd ?? "\0"));
    if (text.includes("$") || text.includes("`") || text.includes("\0")) return null;
  }
  if (!isAbsolute(text)) {
    if (!cwd) return null;
    text = resolve(cwd, text);
  }
  return resolve(text);
}

function deleteTargetRefusal(target: Word, cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  const expanded = expandWord(target.glob ? { ...target, text: staticPrefix(target.text) } : target, cwd, paths);
  if (expanded === null) {
    return {
      rule: "delete-outside-workspace",
      message: `later.dog refused this: it deletes ${target.text} recursively, and later.dog cannot tell where that is. Write the literal path inside this dog's workspace or /tmp.`,
    };
  }
  const allowed = target.glob
    ? [...paths.roots, ...paths.temp].some((root) => within(expanded, root, true))
    : [...paths.roots, ...paths.temp].some((root) => within(expanded, root, false));
  if (allowed) return null;
  return {
    rule: "delete-outside-workspace",
    message: `later.dog refused this: it deletes ${target.glob ? target.text : expanded} recursively, outside this dog's workspace and /tmp.`,
  };
}

function staticPrefix(text: string): string {
  const parts = text.split("/");
  const firstGlob = parts.findIndex((part) => /[*?[]/.test(part));
  const kept = parts.slice(0, firstGlob === -1 ? parts.length : firstGlob).join("/");
  return kept === "" ? (text.startsWith("/") ? "/" : ".") : kept;
}

function rmRefusal(args: Word[], cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  let recursive = false;
  const targets: Word[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg.text === "--") {
      options = false;
      continue;
    }
    if (options && arg.text.startsWith("--")) {
      if (arg.text === "--recursive") recursive = true;
      continue;
    }
    if (options && arg.text.startsWith("-") && arg.text.length > 1) {
      if (/[rR]/.test(arg.text.slice(1))) recursive = true;
      continue;
    }
    targets.push(arg);
  }
  if (!recursive) return null;
  for (const target of targets) {
    const refusal = deleteTargetRefusal(target, cwd, paths);
    if (refusal) return refusal;
  }
  return null;
}

function findRefusal(args: Word[], cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  if (!args.some((arg) => arg.text === "-delete")) return null;
  let rest = args;
  while (rest[0] && /^-[HLP]$|^-O\d$/.test(rest[0].text)) rest = rest.slice(1);
  while (rest[0]?.text === "-D") rest = rest.slice(2);
  const roots: Word[] = [];
  for (const arg of rest) {
    if (arg.text.startsWith("-") || arg.text === "(" || arg.text === "!") break;
    roots.push(arg);
  }
  for (const root of roots.length ? roots : [{ text: ".", glob: false, vars: false }]) {
    const refusal = deleteTargetRefusal(root, cwd, paths);
    if (refusal) return refusal;
  }
  return null;
}

const deleteRepository = (): OwnerGuardRefusal => ({
  rule: "delete-remote-repository",
  message: "later.dog refused this: deleting a remote repository is never allowed for a dog.",
});

function ghRefusal(args: Word[]): OwnerGuardRefusal | null {
  const [sub, action] = args.map((arg) => arg.text);
  if (sub === "repo" && action === "delete") return deleteRepository();
  if (sub !== "api") return null;
  let method = "";
  const positional: string[] = [];
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const text = rest[i]!.text;
    if (text === "-X" || text === "--method") {
      method = rest[i + 1]?.text ?? "";
      i++;
      continue;
    }
    if (text.startsWith("--method=")) {
      method = text.slice("--method=".length);
      continue;
    }
    if (/^-X[A-Za-z]+$/.test(text)) {
      method = text.slice(2);
      continue;
    }
    if (GH_API_VALUE_OPTIONS.has(text)) {
      i++;
      continue;
    }
    if (text.startsWith("-")) continue;
    positional.push(text);
  }
  return method.toUpperCase() === "DELETE" && positional.some((endpoint) => REPO_PATH.test(endpoint)) ? deleteRepository() : null;
}

function curlRefusal(args: Word[]): OwnerGuardRefusal | null {
  let method = "";
  const urls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (text === "-X" || text === "--request") {
      method = args[i + 1]?.text ?? "";
      i++;
      continue;
    }
    if (text.startsWith("--request=")) method = text.slice("--request=".length);
    else if (/^-X[A-Za-z]+$/.test(text)) method = text.slice(2);
    else if (/^https?:\/\//i.test(text)) urls.push(text);
  }
  if (method.toUpperCase() !== "DELETE") return null;
  return urls.some((url) => {
    try {
      return REPO_PATH.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }) ? deleteRepository() : null;
}

interface PushPlan {
  dir: string | undefined;
  remote: string;
  targets: { ref: string | null; forced: boolean }[];
  forcesAll: boolean;
}

function pushPlan(args: Word[], dir: string | undefined): PushPlan | null {
  let force = false;
  let wide = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (PUSH_VALUE_OPTIONS.has(text)) {
      i++;
      continue;
    }
    if (text === "--force" || text.startsWith("--force-with-lease")) force = true;
    else if (text === "--mirror" || text === "--all" || text === "--branches") wide = true;
    else if (/^-[A-Za-z]+$/.test(text) && text.slice(1).includes("f")) force = true;
    else if (!text.startsWith("-")) positional.push(text);
  }
  const [remote = "origin", ...refspecs] = positional;
  const targets = refspecs.length
    ? refspecs.map((spec) => {
      const forced = force || spec.startsWith("+");
      const bare = spec.replace(/^\+/, "");
      const colon = bare.indexOf(":");
      const destination = colon === -1 ? bare : bare.slice(colon + 1) || bare.slice(0, colon);
      const ref = destination.replace(/^refs\/heads\//, "");
      return { ref: ref === "HEAD" || ref === "@" ? null : ref, forced };
    })
    : [{ ref: null, forced: force }];
  if (!force && !targets.some((target) => target.forced)) return null;
  return { dir, remote, targets, forcesAll: force && wide };
}

async function pushRefusal(plan: PushPlan, git: GitLookup): Promise<OwnerGuardRefusal | null> {
  const remoteName = /^[\w.-]+$/.test(plan.remote) ? plan.remote : "origin";
  const resolved = plan.dir ? await git.defaultBranch(plan.dir, remoteName).catch(() => null) : null;
  const isDefault = (branch: string) => resolved ? branch === resolved : branch === "main" || branch === "master";
  const named = resolved ?? "the default branch";
  if (plan.forcesAll) {
    return {
      rule: "force-push-default-branch",
      message: `later.dog refused this: it force-pushes every branch, including ${named}, the repository's default branch. Force-push only your own branch.`,
    };
  }
  for (const target of plan.targets) {
    if (!target.forced) continue;
    let branch = target.ref;
    if (branch === null) {
      branch = plan.dir ? await git.currentBranch(plan.dir).catch(() => null) : null;
      if (branch === null) {
        return {
          rule: "force-push-default-branch",
          message: "later.dog refused this: it force-pushes without naming the branch, and later.dog could not tell which branch that is. Name the branch, for example git push --force-with-lease origin my-branch.",
        };
      }
    }
    if (isDefault(branch)) {
      return {
        rule: "force-push-default-branch",
        message: `later.dog refused this: force-pushing ${branch}, the repository's default branch, is never allowed. Push a new branch and open a pull request instead.`,
      };
    }
  }
  return null;
}

function gitPush(args: Word[], cwd: string | undefined): PushPlan | null {
  let dir = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const text = args[i]!.text;
    if (text === "-C") {
      const target = args[i + 1];
      dir = target && dir !== undefined ? resolve(dir, target.text) : target && isAbsolute(target.text) ? target.text : undefined;
      i++;
      continue;
    }
    if (GIT_VALUE_OPTIONS.has(text)) {
      i++;
      continue;
    }
    if (text.startsWith("-")) continue;
    break;
  }
  if (args[i]?.text !== "push") return null;
  return pushPlan(args.slice(i + 1), dir);
}

function deletesRepositoryTool(tool: string): boolean {
  const action = tool.startsWith("mcp__") ? tool.split("__").slice(2).join("_") : tool;
  const tokens = action.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const at = tokens.indexOf("DELETE");
  if (at === -1) return false;
  const rest = tokens.slice(at + 1).filter((token) => token !== "A" && token !== "THE");
  return rest.length === 1 && (rest[0] === "REPO" || rest[0] === "REPOSITORY");
}

const SHELL_TOOLS = new Set(["bash", "shell", "exec_command", "execute", "run_shell_command", "powershell"]);

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool.replace(/^mcp__[^_]+__/, "").toLowerCase());
}

async function commandRefusal(source: string, cwd: string | undefined, paths: Paths, git: GitLookup, depth: number): Promise<OwnerGuardRefusal | null> {
  let dir = cwd;
  for (const { words } of segments(source)) {
    const command = commandWords(words);
    const head = command[0];
    if (!head) continue;
    const name = basename(head.text);
    const args = command.slice(1);
    if (name === "cd" || name === "pushd") {
      const target = args.find((arg) => !arg.text.startsWith("-") || arg.text === "-");
      if (!target) dir = paths.home;
      else if (target.text === "-") dir = undefined;
      else dir = expandWord(target, dir, paths) ?? undefined;
      continue;
    }
    if (SHELLS.has(name) && depth < DEPTH_LIMIT) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg.text));
      const script = flag === -1 ? undefined : args[flag + 1];
      if (script) {
        const nested = await commandRefusal(script.text, dir, paths, git, depth + 1);
        if (nested) return nested;
      }
      continue;
    }
    if (name === "eval" && depth < DEPTH_LIMIT) {
      const nested = await commandRefusal(args.map((arg) => arg.text).join(" "), dir, paths, git, depth + 1);
      if (nested) return nested;
      continue;
    }
    const refusal = name === "rm" ? rmRefusal(args, dir, paths)
      : name === "find" ? findRefusal(args, dir, paths)
        : name === "gh" ? ghRefusal(args)
          : name === "glab" && args[0]?.text === "repo" && args[1]?.text === "delete" ? deleteRepository()
            : name === "hub" && args[0]?.text === "delete" ? deleteRepository()
              : name === "curl" ? curlRefusal(args)
                : null;
    if (refusal) return refusal;
    if (name === "git") {
      const plan = gitPush(args, dir);
      const pushed = plan ? await pushRefusal(plan, git) : null;
      if (pushed) return pushed;
    }
  }
  return null;
}

function runGit(args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", args, { timeout: 3_000, maxBuffer: 16_384 }, (error, stdout) => {
      done(error ? null : String(stdout).trim() || null);
    });
  });
}

export const systemGit: GitLookup = {
  currentBranch: (dir) => runGit(["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"]),
  async defaultBranch(dir, remote) {
    const ref = await runGit(["-C", dir, "symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
    return ref?.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : null;
  },
};

function withRealpaths(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    out.add(resolve(path));
    try {
      out.add(realpathSync(path));
    } catch {}
  }
  return [...out];
}

export function defaultTempRoots(): string[] {
  return withRealpaths(["/tmp", "/private/tmp", tmpdir()]);
}

export function ownerWorkspaceRoots(candidates: readonly (string | null | undefined)[], home = homedir()): string[] {
  const broad = new Set(["/", resolve(home)]);
  const usable = candidates.filter((path): path is string => typeof path === "string" && isAbsolute(path) && !broad.has(resolve(path)));
  return withRealpaths(usable).filter((path) => !broad.has(path));
}

export function ownerGuardRequest(tool: string, command: string | undefined, summary: string | undefined): OwnerGuardRequest {
  return { tool, command: command ?? (isShellTool(tool) ? summary : undefined) };
}

export async function ownerGuard(request: OwnerGuardRequest, context: OwnerGuardContext): Promise<OwnerGuardRefusal | null> {
  if (deletesRepositoryTool(request.tool)) return deleteRepository();
  if (!request.command || !isShellTool(request.tool)) return null;
  const paths: Paths = {
    home: context.home ?? homedir(),
    temp: [...(context.tempRoots ?? defaultTempRoots())],
    roots: context.workspaceRoots.filter((root) => isAbsolute(root)),
  };
  return commandRefusal(request.command, context.cwd, paths, context.git ?? systemGit, 0);
}
