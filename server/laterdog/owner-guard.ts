import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WRAPPER_VALUE_OPTIONS } from "./home-signals.ts";

export type OwnerGuardRule = "force-push-default-branch" | "delete-remote-repository" | "delete-outside-workspace";

export { DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY } from "../../shared/cloud-home.ts";

export interface OwnerGuardRefusal {
  rule: OwnerGuardRule;
  message: string;
  ask?: string;
}

export interface GitLookup {
  currentBranch(dir: string): Promise<string | null>;
  defaultBranch(dir: string, remote: string): Promise<string | null>;
}

export interface OwnerGuardContext {
  cwd: string | undefined;
  workspaceRoots: readonly string[];
  tempRoots?: readonly string[];
  scratch?: boolean;
  home?: string;
  ownerFull?: boolean;
  git?: GitLookup;
  repositoryRoot?: (cwd: string) => string | null;
}

export interface OwnerGuardRequest {
  tool: string;
  command?: string;
}

export interface ShellWord {
  text: string;
  glob: boolean;
  vars: boolean;
  here?: boolean;
  bare?: boolean;
  unresolved?: boolean;
}

type Word = ShellWord;

type Piece = { word: Word } | { op: string };

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
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
  let bare = false;
  let started = false;
  const flush = () => {
    if (started) pieces.push({ word: { text, glob, vars, ...(bare ? { bare } : {}) } });
    text = "";
    glob = false;
    vars = false;
    bare = false;
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
      let at = i + 1;
      for (const { delimiter, tabs } of heredocs.splice(0)) {
        const body: string[] = [];
        for (;;) {
          const end = source.indexOf("\n", at);
          const line = source.slice(at, end === -1 ? source.length : end);
          at = end === -1 ? source.length : end + 1;
          if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
          body.push(line);
          if (end === -1) break;
        }
        pieces.push({ word: { text: body.join("\n"), glob: false, vars: false, here: true } });
      }
      pieces.push({ op: ";" });
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
      bare = true;
      started = true;
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      const stop = end === -1 ? source.length : end;
      text += source.slice(i, stop + 1);
      vars = true;
      bare = true;
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
    if (ch === "$") {
      vars = true;
      bare = true;
    }
    if (ch === "*" || ch === "?" || ch === "[" || ch === "{") glob = true;
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
  let rest = withoutRedirects(words).filter((word) => !word.here);
  for (;;) {
    const head = rest[0];
    if (!head) return rest;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head.text) || head.text === "{" || head.text === "!") {
      rest = rest.slice(1);
      continue;
    }
    const name = basename(head.text);
    const takesValue = WRAPPER_VALUE_OPTIONS.get(name);
    if (!takesValue) return rest;
    rest = rest.slice(1);
    while (rest[0] && rest[0].text.startsWith("-") && rest[0].text !== "-") {
      const option = rest[0].text;
      rest = rest.slice(1);
      if (option === "--") break;
      if (takesValue.has(option)) rest = rest.slice(1);
    }
    if (name === "timeout") rest = rest.slice(1);
  }
}

function redirectTargets(words: Word[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const text = words[i]!.text;
    if (/^\d*(?:>>?|&>>?|>\|)$/.test(text)) {
      if (words[i + 1]) targets.push(words[i + 1]!.text);
      i++;
      continue;
    }
    const glued = /^\d*(?:>>?|&>>?)([^&].*)$/.exec(text);
    if (glued) targets.push(glued[1]!);
  }
  return targets;
}

interface Paths {
  home: string;
  ownerFull?: boolean;
  temp: string[];
  roots: string[];
  scratch?: boolean;
  links?: Map<string, string>;
  repository?: (cwd: string) => string | null;
  gitElsewhere?: boolean;
}

function within(path: string, root: string, allowEqual: boolean): boolean {
  const rel = relative(root, path);
  if (rel === "") return allowEqual;
  return !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

const SCRATCH_ONLY_INSIDE = new Set(["tmp", ".tmp", "scratch"]);
const SCRATCH_FOLDERS = new Set([...SCRATCH_ONLY_INSIDE, "node_modules", ".next", ".turbo", "__pycache__", ".pytest_cache"]);
const SCRATCH_HOME = /^(?:\/~|\/Users\/[^/]+|\/home\/[^/]+)\/(.+)$/;

function inScratch(path: string, allowEqual: boolean): boolean {
  const rest = SCRATCH_HOME.exec(path)?.[1];
  const parts = rest === undefined ? [] : rest.split("/").filter(Boolean);
  if (parts.length < 2 || parts.includes("..") || parts.includes(".")) return false;
  const last = parts.length - 1;
  if (parts.slice(0, last).some((part) => SCRATCH_FOLDERS.has(part))) return true;
  return SCRATCH_FOLDERS.has(parts[last]!) && (allowEqual || !SCRATCH_ONLY_INSIDE.has(parts[last]!));
}

function repositoryRoot(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function expandWord(word: Word, cwd: string | undefined, paths: Paths): string | null {
  if (word.unresolved) return null;
  let text = word.text;
  if (text === "~" || text.startsWith("~/")) text = paths.home + text.slice(1);
  if (word.vars) {
    text = text
      .replace(/\$\(pwd\)|`pwd`/g, () => cwd ?? "\0")
      .replace(/\$\(git rev-parse --show-toplevel\)|`git rev-parse --show-toplevel`/g, () => (cwd && !paths.gitElsewhere ? (paths.repository ?? repositoryRoot)(cwd) ?? "\0" : "\0"))
      .replace(NAMED, (whole, plain?: string, braced?: string) => {
        const name = plain ?? braced;
        return name === "HOME" ? paths.home : name === "TMPDIR" ? tmpdir() : name === "PWD" ? (cwd ?? "\0") : whole;
      });
    if (text.includes("$") || text.includes("`") || text.includes("\0")) return null;
  }
  if (!isAbsolute(text)) {
    if (!cwd) return null;
    text = resolve(cwd, text);
  }
  return resolve(text);
}

function linked(path: string, links: Map<string, string> | undefined): string {
  for (const [link, target] of links ?? []) {
    if (path === link) return target;
    if (path.startsWith(`${link}/`)) return join(target, path.slice(link.length + 1));
  }
  return path;
}

function realPath(path: string): string {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function deletedPath(expanded: string, text: string, paths: Paths, glob: boolean): string {
  const mapped = linked(expanded, paths.links);
  const followsLast = glob || text.endsWith("/") || mapped !== expanded;
  if (followsLast || !isSymlink(mapped)) return realPath(mapped);
  return join(realPath(dirname(mapped)), basename(mapped));
}

const unreadableDelete = (text: string, recursive = false, ownerFull = false): OwnerGuardRefusal => ({
  rule: "delete-outside-workspace",
  message: `later.dog refused this: it deletes ${text}${recursive ? " recursively" : ""}, and later.dog cannot tell where that is. Write the literal path inside this dog's workspace or /tmp.`,
  ...(!ownerFull ? { ask: `This deletes ${text}${recursive ? " and everything in it" : ""}, and later.dog cannot tell where that is. Allow only if you want it gone.` } : {}),
});

function deleteTargetRefusal(target: Word, cwd: string | undefined, paths: Paths, recursive = true, contents = false): OwnerGuardRefusal | null {
  const glob = target.glob || /[*?[{]/.test(target.text);
  const expanded = expandWord(glob ? { ...target, text: staticPrefix(target.text) } : target, cwd, paths);
  if (expanded === null || /^[^/]*:/.test(target.text)) return unreadableDelete(target.text, recursive, paths.ownerFull);
  const real = deletedPath(expanded, target.text, paths, glob);
  const inside = (path: string) => [...paths.roots, ...paths.temp].some((root) => within(path, root, glob || contents)) || (paths.scratch === true && inScratch(path, glob || contents));
  const protectedRoot = paths.ownerFull && !glob && !contents && [expanded, real].some((path) =>
    path === "/" || path === "/data" || path === resolve(paths.home) || (paths.repository ?? repositoryRoot)(path) === path);
  if (!protectedRoot && inside(real) && inside(expanded)) return null;
  const shown = glob ? target.text : inside(expanded) ? `${expanded} (which leads to ${real})` : expanded;
  return {
    rule: "delete-outside-workspace",
    message: `later.dog refused this: it deletes ${shown}${recursive ? " recursively" : ""}, outside this dog's workspace and /tmp.`,
    ...(!paths.ownerFull ? { ask: `This deletes ${shown}${recursive ? " and everything in it" : ""}, outside this dog's workspace and /tmp. Allow only if you want it gone.` } : {}),
  };
}

function staticPrefix(text: string): string {
  const parts = text.split("/");
  const firstGlob = parts.findIndex((part) => /[*?[{]/.test(part));
  const kept = parts.slice(0, firstGlob === -1 ? parts.length : firstGlob).join("/");
  return kept === "" ? (text.startsWith("/") ? "/" : ".") : kept;
}

function firstRefusal(targets: readonly Word[], cwd: string | undefined, paths: Paths, recursive: boolean, contents = false): OwnerGuardRefusal | null {
  for (const target of targets) {
    const refusal = deleteTargetRefusal(target, cwd, paths, recursive, contents);
    if (refusal) return refusal;
  }
  return null;
}

function operands(args: Word[], valueOptions: ReadonlySet<string> = new Set()): { flags: string[]; targets: Word[] } {
  const flags: string[] = [];
  const targets: Word[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (options && text === "--") {
      options = false;
      continue;
    }
    if (options && text.startsWith("-") && text.length > 1) {
      flags.push(text);
      if (valueOptions.has(text)) i++;
      continue;
    }
    targets.push(args[i]!);
  }
  return { flags, targets };
}

function rmRefusal(args: Word[], cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  const { flags, targets } = operands(args);
  const recursive = flags.some((flag) => flag === "--recursive" || (!flag.startsWith("--") && /[rR]/.test(flag.slice(1))));
  return firstRefusal(targets, cwd, paths, recursive);
}

const FIND_DELETERS = new Set(["rm", "unlink", "shred", "rmdir", "trash"]);

function findRoots(args: Word[]): Word[] {
  let rest = args;
  while (rest[0] && /^-[HLP]$|^-O\d$/.test(rest[0].text)) rest = rest.slice(1);
  while (rest[0]?.text === "-D") rest = rest.slice(2);
  const roots: Word[] = [];
  for (const arg of rest) {
    if (arg.text.startsWith("-") || arg.text === "(" || arg.text === "!") break;
    roots.push(arg);
  }
  return roots.length ? roots : [{ text: ".", glob: false, vars: false }];
}

function findDeletes(args: Word[]): boolean {
  return args.some((arg, index) => arg.text === "-delete" ||
    (/^-(?:exec|execdir|ok|okdir)$/.test(arg.text) && FIND_DELETERS.has(basename(args[index + 1]?.text ?? ""))));
}

function findFollows(args: Word[]): boolean {
  const leading = args.slice(0, args.findIndex((arg) => !/^-[HLP]$|^-O\d$/.test(arg.text)) >>> 0);
  return leading.some((arg) => arg.text === "-L" || arg.text === "-H") || args.some((arg) => arg.text === "-follow");
}

function findRefusal(args: Word[], cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  if (!findDeletes(args)) return null;
  const roots = findFollows(args) ? findRoots(args).map((root) => (root.text.endsWith("/") ? root : { ...root, text: `${root.text}/` })) : findRoots(args);
  return firstRefusal(roots, cwd, paths, true, true);
}

const RSYNC_VALUE_OPTIONS = new Set(["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--files-from", "--exclude-from", "--include-from",
  "--link-dest", "--compare-dest", "--copy-dest", "--backup-dir", "--partial-dir", "--temp-dir", "-T", "--log-file", "--password-file",
  "--chmod", "--chown", "--timeout", "--port", "--bwlimit", "--max-size", "--min-size", "-B", "--block-size", "--suffix", "--out-format", "-M", "--remote-option"]);

function rsyncRefusal(args: Word[], cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  const { flags, targets } = operands(args, RSYNC_VALUE_OPTIONS);
  const deletes = flags.some((flag) => flag.startsWith("--delete") || flag === "--del");
  const removesSources = flags.includes("--remove-source-files");
  if (!targets.length || (!deletes && !removesSources)) return null;
  return (deletes ? firstRefusal(targets.slice(-1), cwd, paths, true, true) : null)
    ?? (removesSources ? firstRefusal(targets.slice(0, -1), cwd, paths, true) : null);
}

interface GitPlace {
  workTree?: Word;
  gitDir: boolean;
  elsewhere: boolean;
}

function gitPlace(step: ShellStep, source: string): GitPlace {
  const assigned = (name: string) => step.words.find((word) => word.text.startsWith(`${name}=`));
  const workTree = assigned("GIT_WORK_TREE");
  return {
    ...(workTree ? { workTree: { ...workTree, text: workTree.text.slice("GIT_WORK_TREE=".length) } } : {}),
    gitDir: assigned("GIT_DIR") !== undefined,
    elsewhere: !workTree && !assigned("GIT_DIR") && /\bGIT_(?:WORK_TREE|DIR)\b/.test(source),
  };
}

function gitCleanRefusal(args: Word[], cwd: string | undefined, paths: Paths, place: GitPlace = { gitDir: false, elsewhere: false }): OwnerGuardRefusal | null {
  let dir = cwd;
  let workTree = place.workTree;
  let gitDir = place.gitDir;
  let i = 0;
  for (; i < args.length; i++) {
    const text = args[i]!.text;
    if (text === "-C") {
      const target = args[i + 1];
      const moved = target ? expandWord(target, dir, paths) : null;
      if (moved === null) return unreadableDelete(`files in ${target?.text ?? "an unnamed folder"}`, false, paths.ownerFull);
      dir = moved;
      i++;
      continue;
    }
    const tree = text === "--work-tree" ? args[i + 1] : text.startsWith("--work-tree=") ? { ...args[i]!, text: text.slice("--work-tree=".length) } : undefined;
    if (tree !== undefined || text === "--work-tree") workTree = tree ?? { text: "", glob: false, vars: true };
    if (text === "--git-dir" || text.startsWith("--git-dir=")) gitDir = true;
    if (GIT_VALUE_OPTIONS.has(text)) {
      i++;
      continue;
    }
    if (text.startsWith("-")) continue;
    break;
  }
  if (args[i]?.text === "worktree" && args[i + 1]?.text === "remove") return firstRefusal(operands(args.slice(i + 2)).targets, dir, paths, true);
  if (args[i]?.text !== "clean") return null;
  const { flags, targets } = operands(args.slice(i + 1), new Set(["-e", "--exclude"]));
  const forced = flags.some((flag) => flag === "--force" || (!flag.startsWith("--") && flag.slice(1).includes("f")));
  if (!forced) return null;
  if (place.elsewhere) return unreadableDelete("untracked files in a repository named elsewhere in this command", true, paths.ownerFull);
  if (workTree) {
    const moved = expandWord(workTree, dir, paths);
    if (moved === null) return unreadableDelete(`untracked files in ${workTree.text || "a work tree it does not name"}`, true, paths.ownerFull);
    dir = moved;
  } else if (gitDir) return unreadableDelete("untracked files in the repository --git-dir names", true, paths.ownerFull);
  if (dir === undefined) return unreadableDelete("untracked files in this folder", false, paths.ownerFull);
  return targets.length ? firstRefusal(targets, dir, paths, true) : firstRefusal([{ text: dir, glob: false, vars: false }], dir, paths, true, true);
}

function shredRefusal(args: Word[], cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  const { flags, targets } = operands(args, new Set(["-n", "--iterations", "-s", "--size", "--random-source"]));
  const removes = flags.some((flag) => flag === "--remove" || flag.startsWith("--remove=") || (!flag.startsWith("--") && flag.slice(1).includes("u")));
  return removes ? firstRefusal(targets, cwd, paths, false) : null;
}

function mvRefusal(args: Word[], cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  const { targets } = operands(args, new Set(["-t", "--target-directory", "-S", "--suffix"]));
  if (targets.length < 2) return null;
  const destination = expandWord(targets.at(-1)!, cwd, paths);
  if (destination === null || !paths.temp.some((root) => within(realPath(destination), root, true))) return null;
  return firstRefusal(targets.slice(0, -1), cwd, paths, true);
}

const XARGS_VALUE_OPTIONS = new Set(["-n", "-I", "-i", "-L", "-l", "-P", "-d", "-E", "-e", "-s", "-a", "--max-args", "--replace", "--max-lines", "--max-procs", "--delimiter", "--eof", "--max-chars", "--arg-file"]);

export function xargsCommand(args: Word[]): Word[] {
  let i = 0;
  while (i < args.length && args[i]!.text.startsWith("-") && args[i]!.text !== "--") {
    if (XARGS_VALUE_OPTIONS.has(args[i]!.text)) i++;
    i++;
  }
  if (args[i]?.text === "--") i++;
  return commandWords(args.slice(i));
}

function pipedWords(step: ShellStep | undefined): Word[] | null {
  if (!step) return null;
  if (step.name === "find") return findRoots(step.args);
  if (step.name === "echo" || step.name === "printf") {
    const words = step.args.filter((arg) => !/^-[neE]+$/.test(arg.text)).flatMap((arg) => arg.text.split(/\s+/).filter(Boolean).map((text) => ({ ...arg, text })));
    return step.args.some((arg) => arg.vars) ? null : words;
  }
  return null;
}

const DELETES_IN_CODE = /(?:\bos\.(?:remove|unlink|rmdir|removedirs)|\bshutil\.rmtree|\brmtree|\.unlink|\.rmdir|\bunlinkSync|\brmdirSync|\brmSync|\bfs\.(?:rm|unlink|rmdir)|\bpromises\.(?:rm|unlink|rmdir)|\brimraf|\bremove_dir_all|\bremove_file|\bFileUtils\.rm\w*|\bFile\.delete|\bDir\.rmdir|\bunlink)\s*[(\s]/;

export function codeLiterals(code: string): string[] {
  return [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function codeRefusal(code: string, cwd: string | undefined, paths: Paths): OwnerGuardRefusal | null {
  if (!DELETES_IN_CODE.test(code)) return null;
  const targets = codeLiterals(code).filter((text) => /^(?:\/|~|\.{1,2}\/)|\//.test(text));
  if (!targets.length || /\$\{|\bjoin\(|\+\s*["'`]|["'`]\s*\+|\bf["']|%s|\.format\(/.test(code)) return unreadableDelete("files named inside a program", false, paths.ownerFull);
  return firstRefusal(targets.map((text) => ({ text, glob: /[*?[]/.test(text), vars: false })), cwd, paths, true);
}

const deleteRepository = (): OwnerGuardRefusal => ({
  rule: "delete-remote-repository",
  message: "later.dog refused this: deleting a remote repository is never allowed for a dog.",
});

export interface ApiCall {
  method: string;
  endpoints: string[];
  fields: Record<string, string>;
}

const FIELD_OPTIONS = new Set(["-f", "--field", "-F", "--raw-field"]);

export function apiCall(args: Word[]): ApiCall | null {
  if (args[0]?.text !== "api") return null;
  let method = "";
  const endpoints: string[] = [];
  const fields: Record<string, string> = {};
  let writes = false;
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
    const field = FIELD_OPTIONS.has(text) ? rest[i + 1]?.text : /^(?:--field=|--raw-field=|-[fF])(.+)$/.exec(text)?.[1];
    if (field !== undefined) {
      writes = true;
      const at = field.indexOf("=");
      if (at > 0) fields[field.slice(0, at)] = field.slice(at + 1);
      if (FIELD_OPTIONS.has(text)) i++;
      continue;
    }
    if (text === "--input") writes = true;
    if (GH_API_VALUE_OPTIONS.has(text)) {
      i++;
      continue;
    }
    if (text.startsWith("-")) continue;
    endpoints.push(text);
  }
  return { method: (method || (writes ? "POST" : "GET")).toUpperCase(), endpoints, fields };
}

const REFS_PATH = /^\/?(?:api\/v3\/)?repos\/[^/\s?#]+\/[^/\s?#]+\/git\/refs(?:\/([^?#\s]*))?/;

export function apiRefMove(call: ApiCall): { ref: string; force: boolean } | null {
  if (!["POST", "PATCH", "PUT"].includes(call.method)) return null;
  for (const endpoint of call.endpoints) {
    const match = REFS_PATH.exec(endpoint);
    if (!match) continue;
    const ref = (match[1] || call.fields.ref || "").replace(/^refs\//, "").replace(/^heads\//, "");
    return { ref, force: /^(?:true|1)$/i.test(call.fields.force ?? "") };
  }
  return null;
}

function ghRefusal(args: Word[]): OwnerGuardRefusal | null {
  if (args[0]?.text === "repo" && args[1]?.text === "delete") return deleteRepository();
  const call = apiCall(args);
  if (!call) return null;
  if (call.endpoints.includes("graphql") && /\bupdateRefs?\b[\s\S]*\bforce\s*:\s*true\b/.test(call.fields.query ?? "")) {
    return {
      rule: "force-push-default-branch",
      message: "later.dog refused this: it force-moves a branch through the API, and later.dog could not tell which branch that is. Push a new branch and open a pull request instead.",
    };
  }
  const moved = apiRefMove(call);
  if (moved?.force && (moved.ref === "main" || moved.ref === "master")) return apiForceRefusal(moved.ref);
  return call.method === "DELETE" && call.endpoints.some((endpoint) => REPO_PATH.test(endpoint)) ? deleteRepository() : null;
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

export interface ShellStep {
  name: string;
  args: Word[];
  words: Word[];
  here: string[];
  writes: string[];
  dir: string | undefined;
  piped: ShellStep | undefined;
  code: string | undefined;
  depth: number;
  input?: "xargs" | "find";
}

const INTERPRETERS = new Set(["python", "node", "nodejs", "perl", "ruby", "php", "bun", "osascript"]);
const CODE_FLAGS = new Set(["-c", "-e", "-E", "--eval", "-r", "-p", "--print"]);

function inlineCode(name: string, args: Word[], here: string[]): string | undefined {
  if (!INTERPRETERS.has(name.replace(/[\d.]+$/, ""))) return undefined;
  const flag = args.findIndex((arg) => CODE_FLAGS.has(arg.text) || /^-[a-zA-Z]*[ce]$/.test(arg.text));
  const parts = [...(flag === -1 ? [] : [args[flag + 1]?.text ?? ""]), ...here];
  return parts.length ? parts.join("\n") : undefined;
}

function substitutions(word: Word): string[] {
  if (!word.vars) return [];
  const found: string[] = [];
  const text = word.text;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) break;
      found.push(text.slice(i + 1, end));
      i = end;
      continue;
    }
    if (text[i] !== "$" || text[i + 1] !== "(" || text[i + 2] === "(") continue;
    let level = 0;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === "(") level++;
      else if (text[j] === ")" && --level === 0) break;
    }
    found.push(text.slice(i + 2, j));
    i = j;
  }
  return found;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const WHOLE_VARIABLE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const DECLARERS = new Set(["export", "declare", "typeset", "readonly", "local"]);

const MAKES_TEMP = /^(?:\$\(|`)mktemp(?:\s+(?:-d|-u|-q|-t|--directory|--quiet|--dry-run|-dt|-td))*(?:\s+[A-Za-z0-9._X-]+)?(?:\)|`)$/;
const DEFAULT_IFS = " \t\n";

const READERS = new Set(["read", "mapfile", "readarray", "getopts", "let"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function forgetRewritten(words: Word[], assigned: Map<string, string>): void {
  const plain = withoutRedirects(words).filter((word) => !word.here);
  for (const word of plain) {
    const appended = /^([A-Za-z_][A-Za-z0-9_]*)\+=/.exec(word.text);
    if (appended) assigned.delete(appended[1]!);
  }
  if (plain[0]?.text === "for" && plain[1]) assigned.delete(plain[1].text);
  const command = commandWords(words);
  const name = command[0]?.text ?? "";
  const args = command.slice(1);
  if (name === "unset" && !args.some((arg) => arg.text === "-f")) for (const arg of args) assigned.delete(arg.text);
  if (READERS.has(name)) for (const arg of args) assigned.delete(arg.text.split("=")[0]!);
  if (name === "printf") {
    const at = args.findIndex((arg) => arg.text === "-v");
    if (at !== -1 && args[at + 1] && IDENTIFIER.test(args[at + 1]!.text)) assigned.delete(args[at + 1]!.text);
  }
}

function remember(words: Word[], assigned: Map<string, string>): void {
  const plain = withoutRedirects(words).filter((word) => !word.here);
  const declares = DECLARERS.has(plain[0]?.text ?? "");
  const candidates = declares ? plain.slice(1).filter((word) => !word.text.startsWith("-")) : plain;
  if (!declares && !plain.every((word) => ASSIGNMENT.test(word.text))) return;
  for (const word of candidates) {
    const match = ASSIGNMENT.exec(word.text);
    if (!match) continue;
    if (MAKES_TEMP.test(match[2]!) && !word.unresolved) {
      const temp = assigned.get("TMPDIR");
      if (temp && isAbsolute(temp)) assigned.set(match[1]!, join(temp, "later-dog-mktemp"));
      else assigned.delete(match[1]!);
    } else if (word.vars || word.glob || word.unresolved) assigned.delete(match[1]!);
    else assigned.set(match[1]!, match[2]!);
  }
}

const NAMED = /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g;

function resolved(words: Word[], assigned: Map<string, string>): Word[] {
  const plainWords = withoutRedirects(words).filter((word) => !word.here);
  const declares = DECLARERS.has(plainWords[0]?.text ?? "");
  const assignments = new Set<Word>();
  for (const word of declares ? plainWords.slice(1) : plainWords) {
    if (ASSIGNMENT.test(word.text)) assignments.add(word);
    else if (!declares) break;
  }
  return words.flatMap((word): Word[] => {
    if (!word.vars) return [word];
    const split = word.bare && !assignments.has(word);
    if (split && assigned.get("IFS") !== DEFAULT_IFS) return [{ ...word, unresolved: true }];
    const match = WHOLE_VARIABLE.exec(word.text);
    const value = match ? assigned.get(match[1] ?? match[2]!) : undefined;
    if (value !== undefined) {
      const parts = split ? value.split(/[ \t\n]+/).filter(Boolean) : [value];
      return parts.map((text) => ({ ...word, text, vars: false, glob: split === true && /[*?[{]/.test(text), bare: false }));
    }
    if (match) return [{ ...word, unresolved: true }];
    let unresolved = false;
    const text = word.text.replace(NAMED, (whole, name?: string, braced?: string) => {
      const known = assigned.get((name ?? braced)!);
      if (known === undefined) unresolved = true;
      return known ?? whole;
    });
    if (unresolved) return [{ ...word, unresolved: true }];
    if (text === word.text) return [word];
    const plain = !/[$`]/.test(text);
    const parts = split ? text.split(/[ \t\n]+/).filter(Boolean) : [text];
    return parts.map((part) => ({ ...word, text: part, vars: !plain, ...(plain ? { bare: false } : {}) }));
  });
}

function initialVariables(cwd: string | undefined, home: string): Map<string, string> {
  const assigned = new Map([["HOME", home], ["TMPDIR", tmpdir()], ["IFS", DEFAULT_IFS]]);
  if (cwd) assigned.set("PWD", cwd);
  return assigned;
}

export function shellSteps(source: string, cwd: string | undefined, home: string, depth = 0, out: ShellStep[] = [], assigned = initialVariables(cwd, home), exported = new Set(["HOME", "TMPDIR", "PWD"])): ShellStep[] {
  let dir = cwd;
  let previous: ShellStep | undefined;
  let pipeOpen = false;
  const paths: Paths = { home, temp: [], roots: [] };
  for (const { words: written, after } of segments(source)) {
    const words = resolved(written, assigned);
    forgetRewritten(words, assigned);
    remember(words, assigned);
    if (words[0]?.text === "export") {
      const remove = words.some((word) => word.text === "-n");
      for (const word of words.slice(1)) {
        const name = word.text.split("=")[0]!;
        if (IDENTIFIER.test(name)) {
          if (remove) exported.delete(name);
          else exported.add(name);
        }
      }
    }
    if (depth < DEPTH_LIMIT) for (const word of words) for (const inner of substitutions(word)) shellSteps(inner, dir, home, depth + 1, out, new Map(assigned), new Set(exported));
    const command = commandWords(words);
    const head = command[0];
    if (!head) {
      previous = undefined;
      pipeOpen = false;
      continue;
    }
    const name = basename(head.text);
    const args = command.slice(1);
    const here = words.filter((word) => word.here).map((word) => word.text);
    const step: ShellStep = {
      name, args, words: words.filter((word) => !word.here), here, writes: redirectTargets(words), dir,
      piped: pipeOpen ? previous : undefined, code: inlineCode(name, args, here), depth,
    };
    out.push(step);
    if (name === "cd" || name === "pushd") {
      const target = args.find((arg) => !arg.text.startsWith("-") || arg.text === "-");
      if (!target) dir = home;
      else if (target.text === "-") dir = undefined;
      else dir = expandWord(target, dir, paths) ?? undefined;
      if (dir) assigned.set("PWD", dir);
      else assigned.delete("PWD");
    }
    if (depth < DEPTH_LIMIT) {
      if (SHELLS.has(name)) {
        const inherited = new Map([...assigned].filter(([key]) => exported.has(key)));
        inherited.set("IFS", DEFAULT_IFS);
        const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg.text));
        const script = flag === -1 ? undefined : args[flag + 1];
        if (script) shellSteps(script.text, dir, home, depth + 1, out, new Map(inherited), new Set(exported));
        for (const body of here) shellSteps(body, dir, home, depth + 1, out, new Map(inherited), new Set(exported));
        const printed = step.piped && (step.piped.name === "echo" || step.piped.name === "printf") ? step.piped.args.filter((arg) => !/^-[neE]+$/.test(arg.text)) : [];
        if (flag === -1 && printed.length && !printed.some((arg) => arg.vars)) shellSteps(printed.map((arg) => arg.text).join(" ").replace(/\\n/g, "\n"), dir, home, depth + 1, out, new Map(inherited), new Set(exported));
      }
      if (name === "eval") shellSteps(args.map((arg) => arg.text).join(" "), dir, home, depth + 1, out, assigned, exported);
      if (name === "xargs") {
        const run = xargsCommand(args);
        if (run.length) out.push({ ...step, name: basename(run[0]!.text), args: run.slice(1), words: run, code: undefined, depth: depth + 1, input: "xargs" });
      }
      if (name === "find") {
        for (let i = 0; i < args.length; i++) {
          if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i]!.text)) continue;
          const stop = args.findIndex((arg, index) => index > i && (arg.text === ";" || arg.text === "+"));
          const run = args.slice(i + 1, stop === -1 ? undefined : stop);
          if (run.length) out.push({ ...step, name: basename(run[0]!.text), args: run.slice(1), words: run, piped: step, code: undefined, depth: depth + 1, input: "find" });
        }
      }
    }
    previous = step;
    pipeOpen = after === "|" || after === "|&";
  }
  return out;
}

type Finding = { refusal: OwnerGuardRefusal } | { push: PushPlan } | { apiForce: { ref: string; dir: string | undefined } };

const apiForceRefusal = (ref: string): OwnerGuardRefusal => ({
  rule: "force-push-default-branch",
  message: `later.dog refused this: it force-moves ${ref}, the repository's default branch, through the API, which is never allowed. Push a new branch and open a pull request instead.`,
});

const DELETERS: Record<string, (args: Word[], cwd: string | undefined, paths: Paths) => OwnerGuardRefusal | null> = {
  rm: rmRefusal,
  find: findRefusal,
  rsync: rsyncRefusal,
  git: gitCleanRefusal,
  shred: shredRefusal,
  mv: mvRefusal,
  unlink: (args, cwd, paths) => firstRefusal(operands(args).targets, cwd, paths, false),
  rmdir: (args, cwd, paths) => firstRefusal(operands(args).targets, cwd, paths, false),
  trash: (args, cwd, paths) => firstRefusal(operands(args).targets, cwd, paths, true),
};

function stepDeleteRefusal(step: ShellStep, paths: Paths, source: string): OwnerGuardRefusal | null {
  if (step.name === "ln" && step.args.some((arg) => /^-[a-zA-Z]*s/.test(arg.text) || arg.text === "--symbolic")) {
    const { targets } = operands(step.args, new Set(["-t", "--target-directory", "-S", "--suffix"]));
    const [target, link] = targets.length >= 2 ? [targets[0]!, targets.at(-1)!] : [undefined, undefined];
    const from = link && expandWord(link, step.dir, paths);
    const to = target && expandWord(target, step.dir, paths);
    if (from && to) (paths.links ??= new Map()).set(from, realPath(to));
    return null;
  }
  if (step.input === "find") return null;
  if (step.input === "xargs" && FIND_DELETERS.has(step.name)) {
    const input = pipedWords(step.piped);
    if (input === null) return unreadableDelete("files read from another command", false, paths.ownerFull);
    return DELETERS[step.name]?.([...step.args, ...input], step.dir, paths) ?? null;
  }
  if (step.code !== undefined) {
    const refusal = codeRefusal(step.code, step.dir, paths);
    if (refusal) return refusal;
  }
  if (step.name === "git") return gitCleanRefusal(step.args, step.dir, paths, gitPlace(step, source));
  return DELETERS[step.name]?.(step.args, step.dir, paths) ?? null;
}

function commandFindings(source: string, cwd: string | undefined, paths: Paths, depth: number, out: Finding[] = []): Finding[] {
  paths.gitElsewhere ||= /\bGIT_(?:WORK_TREE|DIR)\b/.test(source);
  for (const step of shellSteps(source, cwd, paths.home, depth)) {
    const { name, args } = step;
    const refusal = stepDeleteRefusal(step, paths, source)
      ?? (name === "gh" ? ghRefusal(args)
        : name === "glab" && args[0]?.text === "repo" && args[1]?.text === "delete" ? deleteRepository()
          : name === "hub" && args[0]?.text === "delete" ? deleteRepository()
            : name === "curl" ? curlRefusal(args)
              : null);
    if (refusal) out.push({ refusal });
    const call = name === "gh" ? apiCall(args) : null;
    const forced = call ? apiRefMove(call) : null;
    if (forced?.force && forced.ref) out.push({ apiForce: { ref: forced.ref, dir: step.dir } });
    if (name === "git") {
      const plan = gitPush(args, step.dir);
      if (plan) out.push({ push: plan });
    }
  }
  return out;
}

async function commandRefusal(findings: readonly Finding[], git: GitLookup): Promise<OwnerGuardRefusal | null> {
  for (const finding of findings) {
    if ("refusal" in finding) return finding.refusal;
    if ("apiForce" in finding) {
      const { ref, dir } = finding.apiForce;
      const named = dir ? await git.defaultBranch(dir, "origin").catch(() => null) : null;
      if (named === ref) return apiForceRefusal(ref);
      continue;
    }
    const pushed = await pushRefusal(finding.push, git);
    if (pushed) return pushed;
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

const SYSTEM_LINKS: Readonly<Record<string, string>> = { "/tmp": "/private/tmp", "/var": "/private/var", "/etc": "/private/etc", "/home": "/System/Volumes/Data/home" };

function withRealpaths(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const given = resolve(path);
    out.add(given);
    out.add(join(realPath(dirname(given)), basename(given)));
    const system = SYSTEM_LINKS[given];
    if (system && isSymlink(given) && realPath(given) === system) out.add(system);
  }
  return [...out];
}

function holds(folder: string, path: string): boolean {
  return folder === "/" || within(path, folder, true);
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

const CACHE_FOLDERS = [".cache", ".npm", ".pnpm-store", ".local/share/pnpm/store", "Library/Caches", ".bun/install/cache", ".yarn/cache"];

function guardPaths(context: OwnerGuardContext): Paths {
  const home = context.home ?? homedir();
  const homes = [...new Set([resolve(home), realPath(resolve(home))])];
  const roots = withRealpaths(context.workspaceRoots.filter((root) => isAbsolute(root)))
    .filter((root) => !homes.some((place) => holds(root, place)));
  const caches = CACHE_FOLDERS.flatMap((folder) => homes.map((place) => join(place, folder)));
  const temp = [...withRealpaths(context.tempRoots ?? defaultTempRoots()), ...caches]
    .filter((folder) => ![...homes, ...roots].some((place) => holds(folder, place)));
  return {
    home,
    ownerFull: context.ownerFull,
    temp,
    roots,
    ...(context.scratch ? { scratch: true } : {}),
    ...(context.repositoryRoot ? { repository: context.repositoryRoot } : {}),
  };
}

export function deletesOutsideWorkspace(command: string, context: OwnerGuardContext): OwnerGuardRefusal | null {
  return commandFindings(command, context.cwd, guardPaths(context), 0)
    .map((finding) => ("refusal" in finding ? finding.refusal : null))
    .find((refusal) => refusal?.rule === "delete-outside-workspace") ?? null;
}

export async function ownerGuard(request: OwnerGuardRequest, context: OwnerGuardContext): Promise<OwnerGuardRefusal | null> {
  if (deletesRepositoryTool(request.tool)) return deleteRepository();
  if (!request.command || !isShellTool(request.tool)) return null;
  return commandRefusal(commandFindings(request.command, context.cwd, guardPaths(context), 0), context.git ?? systemGit);
}
