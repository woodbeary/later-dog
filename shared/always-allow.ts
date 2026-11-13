export const RUN_KEY = "run:";
export const EXACT_KEY = "exact:";
export const EXACT_SPLIT = " :: ";
export const FILES_EDIT_KEY = "files:edit";
export const FILES_READ_KEY = "files:read";
export const TOOL_KEY = "tool:";
export const COMPUTER_KEY = "computer:";
export const MAX_GRANT_KEY_BYTES = 480;

export type ArgumentRule = "none" | "checked" | "remote";

export interface ListedCommand {
  program: string;
  sub?: string;
  script?: true;
  args: ArgumentRule;
  flags?: readonly string[];
  denied?: readonly string[];
  covers: string;
  reason: string;
}

const PUSH_DENIED = ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--all", "--delete", "-d", "--prune", "--tags", "--follow-tags", "--set-upstream", "-u", "--repo"];
const LOCK_INSTALL = ["--frozen-lockfile", "--prefer-offline", "--offline", "--immutable"];

export const LISTED_COMMANDS: readonly ListedCommand[] = [
  { program: "git", sub: "status", args: "checked", covers: "show which files changed in this repository", reason: "reads only" },
  { program: "git", sub: "diff", args: "checked", denied: ["--ext-diff", "--textconv", "--output", "--no-index"], covers: "show changes in this repository", reason: "reads only; options that run configured programs or write a file are refused" },
  { program: "git", sub: "log", args: "checked", denied: ["--ext-diff", "--textconv", "--output"], covers: "show this repository's history", reason: "reads only" },
  { program: "git", sub: "show", args: "checked", denied: ["--ext-diff", "--textconv", "--output"], covers: "show a commit in this repository", reason: "reads only" },
  { program: "git", sub: "rev-parse", args: "checked", covers: "look up commit names in this repository", reason: "reads only" },
  { program: "git", sub: "ls-files", args: "checked", covers: "list the files this repository tracks", reason: "reads only" },
  { program: "git", sub: "add", args: "checked", covers: "stage files inside its own folders", reason: "changes only the repository's index; paths are checked" },
  { program: "git", sub: "commit", args: "checked", denied: ["--template", "-t", "--edit", "--reuse-message", "-C", "--reedit-message", "--fixup", "--squash"], covers: "record staged changes as a commit in this repository", reason: "local only; hooks live under .git, which it can never edit without asking" },
  { program: "git", sub: "switch", args: "checked", denied: ["--track", "-t", "--set-upstream-to"], covers: "switch branches in this repository", reason: "local only" },
  { program: "git", sub: "checkout", args: "checked", denied: ["--track", "-t", "--set-upstream-to", "--patch", "-p"], covers: "switch branches or restore files inside its own folders", reason: "local only; paths are checked" },
  { program: "git", sub: "stash", args: "checked", covers: "set aside and bring back uncommitted changes in this repository", reason: "local only" },
  { program: "git", sub: "fetch", args: "remote", denied: ["--all", "--multiple", "--upload-pack", "--prune", "--tags"], covers: "download from a remote this repository already has", reason: "no URLs, refspecs or upload programs" },
  { program: "git", sub: "pull", args: "remote", denied: ["--all", "--upload-pack", "--rebase", "-r", "--strategy", "-s", "--strategy-option", "-X"], covers: "download and merge from a remote this repository already has", reason: "no URLs, refspecs or merge programs" },
  { program: "git", sub: "push", args: "remote", denied: PUSH_DENIED, covers: "push branches to a remote this repository already has, without force or deleting anything", reason: "no URLs, refspecs, force, deletes or mirror; force-pushing the main branch is also held by the owner guard" },
  { program: "pnpm", sub: "install", args: "none", flags: LOCK_INSTALL, covers: "install the packages this folder's lock file already lists", reason: "no new package names" },
  { program: "pnpm", sub: "i", args: "none", flags: LOCK_INSTALL, covers: "install the packages this folder's lock file already lists", reason: "no new package names" },
  { program: "npm", sub: "install", args: "none", covers: "install the packages this folder's lock file already lists", reason: "no new package names" },
  { program: "npm", sub: "ci", args: "none", covers: "install the packages this folder's lock file already lists", reason: "no new package names" },
  { program: "yarn", sub: "install", args: "none", flags: LOCK_INSTALL, covers: "install the packages this folder's lock file already lists", reason: "no new package names" },
  { program: "pnpm", sub: "test", args: "none", covers: "run this folder's test script", reason: "the script lives in package.json, which it can never edit without asking" },
  { program: "npm", sub: "test", args: "none", covers: "run this folder's test script", reason: "the script lives in package.json, which it can never edit without asking" },
  { program: "yarn", sub: "test", args: "none", covers: "run this folder's test script", reason: "the script lives in package.json, which it can never edit without asking" },
  { program: "pnpm", sub: "run", script: true, args: "none", covers: "run the package script named here, as this folder's package.json defines it", reason: "one named script; package.json edits always ask" },
  { program: "npm", sub: "run", script: true, args: "none", covers: "run the package script named here, as this folder's package.json defines it", reason: "one named script; package.json edits always ask" },
  { program: "yarn", sub: "run", script: true, args: "none", covers: "run the package script named here, as this folder's package.json defines it", reason: "one named script; package.json edits always ask" },
  { program: "gh", sub: "pr view", args: "checked", denied: ["--web", "-w"], covers: "read a pull request on GitHub", reason: "reads only" },
  { program: "gh", sub: "pr list", args: "checked", denied: ["--web", "-w"], covers: "list pull requests on GitHub", reason: "reads only" },
  { program: "gh", sub: "pr status", args: "checked", covers: "see the status of your pull requests on GitHub", reason: "reads only" },
  { program: "gh", sub: "pr diff", args: "checked", denied: ["--web", "-w"], covers: "read a pull request's changes on GitHub", reason: "reads only" },
  { program: "gh", sub: "pr checks", args: "checked", denied: ["--web", "-w", "--watch"], covers: "read a pull request's checks on GitHub", reason: "reads only" },
  { program: "gh", sub: "issue view", args: "checked", denied: ["--web", "-w"], covers: "read an issue on GitHub", reason: "reads only" },
  { program: "gh", sub: "issue list", args: "checked", denied: ["--web", "-w"], covers: "list issues on GitHub", reason: "reads only" },
  { program: "gh", sub: "run view", args: "checked", denied: ["--web", "-w"], covers: "read a workflow run on GitHub", reason: "reads only" },
  { program: "gh", sub: "run list", args: "checked", covers: "list workflow runs on GitHub", reason: "reads only" },
  { program: "ls", args: "checked", covers: "list files inside its own folders", reason: "reads only; paths are checked" },
  { program: "pwd", args: "none", covers: "print its working folder", reason: "reads only" },
  { program: "cat", args: "checked", covers: "read files inside its own folders", reason: "reads only; paths are checked" },
  { program: "head", args: "checked", covers: "read the start of files inside its own folders", reason: "reads only; paths are checked" },
  { program: "tail", args: "checked", covers: "read the end of files inside its own folders", reason: "reads only; paths are checked" },
  { program: "wc", args: "checked", covers: "count lines in files inside its own folders", reason: "reads only; paths are checked" },
  { program: "grep", args: "checked", covers: "search files inside its own folders", reason: "reads only; paths are checked" },
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
