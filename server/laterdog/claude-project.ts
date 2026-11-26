import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export function physicalClaudePath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

export function claudeSessionWorkspace(cwd: string, configDir: string, sessionId: unknown) {
  const physical = physicalClaudePath(cwd);
  const projects = join(configDir, "projects");
  if (typeof sessionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId) ||
      !lstatSync(projects, { throwIfNoEntry: false })?.isDirectory()) return { physical };
  const source = [...new Set([physical, cwd])].find(folder => {
    const project = join(projects, claudeProjectSlug(folder));
    return lstatSync(project, { throwIfNoEntry: false })?.isDirectory() &&
      lstatSync(join(project, `${sessionId}.jsonl`), { throwIfNoEntry: false })?.isFile();
  });
  return { physical, source };
}
