import { homedir } from "node:os";
import { posix } from "node:path";
import type { PromptPart } from "../system-prompt.ts";

export const HOME_PROJECTS_LISTED = 12;

type Folder = string | null | undefined;

export type HomeProjectSources = {
  bots: readonly { cwd?: Folder; tasks?: readonly { cwd?: Folder }[] }[];
  groups: readonly { cwd?: Folder; pinnedCwd?: Folder; tasks?: readonly { pinnedCwd?: Folder }[] }[];
  config: { newBotDefaults?: { profile?: { cwd?: Folder } } };
};

const LONGEST_PATH = 1024;
const LATERDOG_DATA_SEGMENT = /^\.laterdog/;

const plainText = (value: string) => ![...value].some(char => char < " " || char === "\u007f");

function folderOf(value: Folder): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > LONGEST_PATH || !plainText(value)) return null;
  const folder = posix.normalize(value).replace(/\/+$/, "");
  return folder === "" ? null : folder;
}

const within = (folder: string, root: string) => folder === root || folder.startsWith(`${root}/`);

export function cloudHomeRoots(dataDir: string): string[] {
  return [dataDir, homedir()];
}

export function macProjectFolders(sources: HomeProjectSources, cloudRoots: readonly string[]): string[] {
  const roots = cloudRoots.map(folderOf).filter((root): root is string => root !== null);
  const uses = new Map<string, number>();
  const count = (value: Folder) => {
    const folder = folderOf(value);
    if (!folder || folder.split("/").some(segment => LATERDOG_DATA_SEGMENT.test(segment))) return;
    if (roots.some(root => within(folder, root))) return;
    uses.set(folder, (uses.get(folder) ?? 0) + 1);
  };
  for (const bot of sources.bots) {
    count(bot.cwd);
    for (const task of bot.tasks ?? []) count(task.cwd);
  }
  for (const group of sources.groups) {
    count(group.cwd);
    count(group.pinnedCwd);
    for (const task of group.tasks ?? []) count(task.pinnedCwd);
  }
  count(sources.config.newBotDefaults?.profile?.cwd);
  return [...uses]
    .sort(([a, aUses], [b, bUses]) => bUses - aUses || (a < b ? -1 : a > b ? 1 : 0))
    .map(([folder]) => folder);
}

export function homeProjectsPrompt(folders: readonly string[], macTools: boolean): string {
  const listed = folders.slice(0, HOME_PROJECTS_LISTED);
  const more = folders.length - listed.length;
  const named = listed.length === 0 ? "" : ` (${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""})`;
  const clone = "clone the project's GitHub repository into your own cloud computer with gh if GitHub is connected; otherwise say the Mac is needed.";
  return ` The person's projects are on their Mac${named}, not in this cloud workspace, so don't search for them here.`
    + (macTools
      ? ` To work on one, select the Mac computer and run commands there with shared_computer while the Mac is online. When the Mac is offline, ${clone}`
      : ` You can't reach the Mac from this conversation: to work on one, ${clone}`);
}

export function homeProjectsPart(sources: HomeProjectSources | null, dataDir: string, macTools: boolean): PromptPart {
  return {
    id: "home-projects",
    label: "Projects on the Mac",
    text: sources ? homeProjectsPrompt(macProjectFolders(sources, cloudHomeRoots(dataDir)), macTools) : "",
  };
}
