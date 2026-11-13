export const RUN_KEY = "run:";
export const EXACT_KEY = "exact:";
export const EXACT_SPLIT = " :: ";
export const FILES_EDIT_KEY = "files:edit";
export const FILES_READ_KEY = "files:read";
export const TOOL_KEY = "tool:";
export const COMPUTER_KEY = "computer:";
export const MAX_GRANT_KEY_BYTES = 480;

export type ArgumentRule = "none" | "checked" | "remote" | "branch";

export interface ListedCommand {
  program: string;
  sub?: string;
  script?: true;
  args: ArgumentRule;
  flags?: readonly string[];
  denied?: readonly string[];
  deniedLetters?: string;
  hooks?: true;
  recursive?: string;
  covers: string;
  reason: string;
}

const PUSH_DENIED = ["--push-option", "--recurse-submodules", "--atomic", "--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--all", "--delete", "-d", "--prune", "--tags", "--follow-tags", "--set-upstream", "-u", "--repo"];

export const LISTED_COMMANDS: readonly ListedCommand[] = [
  { program: "git", sub: "status", args: "checked", covers: "show which files changed in this repository", reason: "reads only" },
  { program: "git", sub: "diff", args: "checked", denied: ["--ext-diff", "--textconv", "--output", "--no-index"], covers: "show changes in this repository", reason: "reads only; options that run configured programs or write a file are refused" },
  { program: "git", sub: "log", args: "checked", denied: ["--ext-diff", "--textconv", "--output"], covers: "show this repository's history", reason: "reads only" },
  { program: "git", sub: "show", args: "checked", denied: ["--ext-diff", "--textconv", "--output"], covers: "show a commit in this repository", reason: "reads only" },
  { program: "git", sub: "rev-parse", args: "checked", covers: "look up commit names in this repository", reason: "reads only" },
  { program: "git", sub: "ls-files", args: "checked", covers: "list the files this repository tracks", reason: "reads only" },
  { program: "git", sub: "add", args: "checked", covers: "stage files inside its own folders", reason: "changes only the repository's index; paths are checked" },
  { program: "git", sub: "commit", args: "checked", hooks: true, denied: ["-F", "--file", "--template", "-t", "--edit", "--reuse-message", "-C", "--reedit-message", "--fixup", "--squash"], covers: "record staged changes as a commit in this repository", reason: "local only, and only while the repository has no hooks configured anywhere; with hooks it is exact" },
  { program: "git", sub: "switch", args: "branch", hooks: true, covers: "switch to a branch by its plain name in this repository", reason: "a plain branch name only; exact while hooks are configured" },
  { program: "git", sub: "checkout", args: "branch", hooks: true, covers: "switch to a branch by its plain name in this repository", reason: "a plain branch name only, no paths; exact while hooks are configured" },
  { program: "git", sub: "stash", args: "checked", hooks: true, covers: "set aside and bring back uncommitted changes in this repository", reason: "local only" },
  { program: "git", sub: "fetch", args: "remote", hooks: true, denied: ["--all", "--multiple", "--upload-pack", "--prune", "--tags", "--recurse-submodules", "--refmap"], covers: "download branches, named plainly, from a remote this repository already has", reason: "no URLs, refspecs or upload programs" },
  { program: "git", sub: "pull", args: "remote", hooks: true, denied: ["--all", "--upload-pack", "--rebase", "-r", "--strategy", "-s", "--strategy-option", "-X", "--recurse-submodules", "--allow-unrelated-histories"], covers: "download and merge a branch, named plainly, from a remote this repository already has", reason: "no URLs, refspecs or merge programs" },
  { program: "git", sub: "push", args: "remote", hooks: true, denied: PUSH_DENIED, covers: "push branches, named plainly, to a remote this repository already has, without force or deleting anything", reason: "no URLs, refspecs, force, deletes or mirror; force-pushing the main branch is also held by the owner guard" },
  { program: "gh", sub: "pr view", args: "checked", denied: ["--web", "-w"], covers: "read a pull request on GitHub", reason: "reads only" },
  { program: "gh", sub: "pr list", args: "checked", denied: ["--web", "-w"], covers: "list pull requests on GitHub", reason: "reads only" },
  { program: "gh", sub: "pr status", args: "checked", covers: "see the status of your pull requests on GitHub", reason: "reads only" },
  { program: "gh", sub: "pr diff", args: "checked", denied: ["--web", "-w"], covers: "read a pull request's changes on GitHub", reason: "reads only" },
  { program: "gh", sub: "pr checks", args: "checked", denied: ["--web", "-w", "--watch"], covers: "read a pull request's checks on GitHub", reason: "reads only" },
  { program: "gh", sub: "issue view", args: "checked", denied: ["--web", "-w"], covers: "read an issue on GitHub", reason: "reads only" },
  { program: "gh", sub: "issue list", args: "checked", denied: ["--web", "-w"], covers: "list issues on GitHub", reason: "reads only" },
  { program: "gh", sub: "run view", args: "checked", denied: ["--web", "-w"], covers: "read a workflow run on GitHub", reason: "reads only" },
  { program: "gh", sub: "run list", args: "checked", covers: "list workflow runs on GitHub", reason: "reads only" },
  { program: "ls", args: "checked", denied: ["--dereference", "--dereference-command-line"], deniedLetters: "LH", covers: "list files inside its own folders", reason: "reads only; paths are checked" },
  { program: "pwd", args: "none", covers: "print its working folder", reason: "reads only" },
  { program: "cat", args: "checked", covers: "read files inside its own folders", reason: "reads only; paths are checked" },
  { program: "head", args: "checked", covers: "read the start of files inside its own folders", reason: "reads only; paths are checked" },
  { program: "tail", args: "checked", covers: "read the end of files inside its own folders", reason: "reads only; paths are checked" },
  { program: "wc", args: "checked", denied: ["--files0-from"], covers: "count lines in files inside its own folders", reason: "reads only; paths are checked" },
  { program: "grep", args: "checked", denied: ["--dereference-recursive", "--directories", "-d"], deniedLetters: "R", recursive: "r", covers: "search files inside its own folders", reason: "reads only; paths are checked" },
];

export function listedName(entry: ListedCommand, script?: string): string {
  return [entry.program, entry.sub, script].filter(Boolean).join(" ");
}

export function listedCommand(name: string): { entry: ListedCommand; script?: string } | null {
  for (const entry of LISTED_COMMANDS) {
    const head = listedName(entry);
    if (entry.script) {
      if (name.startsWith(head + " ") && !name.slice(head.length + 1).includes(" ")) return { entry, script: name.slice(head.length + 1) };
    } else if (name === head) return { entry };
  }
  return null;
}

export type GrantShape =
  | { kind: "run"; command: string; covers: string }
  | { kind: "exact"; command: string; cwd: string }
  | { kind: "files"; access: "edit" | "read" }
  | { kind: "tool"; tool: string };

export interface ReadGrant {
  shape: GrantShape;
  onComputer: boolean;
}

export function readGrantKey(key: string): ReadGrant | null {
  const onComputer = key.startsWith(COMPUTER_KEY);
  const rest = onComputer ? key.slice(COMPUTER_KEY.length) : key;
  if (rest.startsWith(RUN_KEY)) {
    const command = rest.slice(RUN_KEY.length);
    const listed = listedCommand(command);
    return listed ? { onComputer, shape: { kind: "run", command, covers: listed.entry.covers } } : null;
  }
  if (rest.startsWith(EXACT_KEY)) {
    const body = rest.slice(EXACT_KEY.length);
    const cut = body.indexOf(EXACT_SPLIT);
    return cut > 0 ? { onComputer, shape: { kind: "exact", cwd: body.slice(0, cut), command: body.slice(cut + EXACT_SPLIT.length) } } : null;
  }
  if (rest === FILES_EDIT_KEY) return { onComputer, shape: { kind: "files", access: "edit" } };
  if (rest === FILES_READ_KEY) return { onComputer, shape: { kind: "files", access: "read" } };
  if (rest.startsWith(TOOL_KEY)) return { onComputer, shape: { kind: "tool", tool: rest.slice(TOOL_KEY.length) } };
  return null;
}

const PURE_PROGRAMS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "grep", "echo", "printf", "date", "whoami", "which", "true", "false", "sleep", "cd", "mkdir", "rm", "rmdir", "mv", "cp", "touch", "kill"]);

export function readsFolderFiles(command: string): boolean {
  const program = command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "").toLowerCase() ?? "";
  return !PURE_PROGRAMS.has(program) || /[|&;]/.test(command);
}
