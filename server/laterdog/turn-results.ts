import { z } from "zod";
import type { FileChange, TurnResultFile, TurnResultLink, TurnResults } from "../../shared/turn-results.ts";

export const RESULT_FILES_SHOWN = 20;
export const RESULT_LINKS_SHOWN = 10;

export const turnResultsSchema = z.object({
  files: z.array(z.object({ path: z.string(), change: z.enum(["created", "edited", "deleted"]) })).max(RESULT_FILES_SHOWN).optional(),
  moreFiles: z.number().int().positive().optional(),
  links: z.array(z.object({ kind: z.enum(["pull-request", "page", "file"]), label: z.string(), url: z.string() })).max(RESULT_LINKS_SHOWN).optional(),
  commands: z.number().int().positive().optional(),
});

export interface TurnResultFacts {
  files?: readonly TurnResultFile[];
  links?: readonly TurnResultLink[];
  commands?: number;
  cwd?: string;
  home?: string;
}

const trimmed = (folder: string | undefined): string | undefined => {
  const clean = folder?.trim().replace(/\/+$/, "");
  return clean ? clean : undefined;
};

function shownPath(path: string, cwd: string | undefined, home: string | undefined): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

function settle(before: FileChange | undefined, now: FileChange): FileChange | null {
  if (before === "created") return now === "deleted" ? null : "created";
  if (before && now === "created") return "edited";
  return now;
}

function netFiles(files: readonly TurnResultFile[], cwd: string | undefined, home: string | undefined): TurnResultFile[] {
  const net = new Map<string, FileChange | null>();
  for (const file of files) {
    const path = shownPath(file.path.trim(), cwd, home);
    if (!path) continue;
    const before = net.get(path);
    net.set(path, before === null ? file.change : settle(before, file.change));
  }
  return [...net].flatMap(([path, change]) => change ? [{ path, change }] : []);
}

export function turnResults(facts: TurnResultFacts): TurnResults | undefined {
  const cwd = trimmed(facts.cwd);
  const home = trimmed(facts.home);
  const files = netFiles(facts.files ?? [], cwd, home);
  const seen = new Set<string>();
  const links = (facts.links ?? []).filter((link) => /^https:\/\/\S+$/.test(link.url) && !seen.has(link.url) && Boolean(seen.add(link.url)))
    .slice(0, RESULT_LINKS_SHOWN)
    .map((link) => ({ kind: link.kind, label: link.label.trim() || link.url, url: link.url }));
  const commands = Number.isInteger(facts.commands) && facts.commands! > 0 ? facts.commands! : 0;
  if (!files.length && !links.length && !commands) return undefined;
  return {
    ...(files.length ? { files: files.slice(0, RESULT_FILES_SHOWN) } : {}),
    ...(files.length > RESULT_FILES_SHOWN ? { moreFiles: files.length - RESULT_FILES_SHOWN } : {}),
    ...(links.length ? { links } : {}),
    ...(commands ? { commands } : {}),
  };
}

export function terminalTurnPatch<R>(ok: boolean, ran: R | undefined, results: TurnResults | undefined): { turnSucceeded: boolean; ran?: R; results?: TurnResults } {
  return { turnSucceeded: ok, ...(ran ? { ran } : {}), ...(results ? { results } : {}) };
}
