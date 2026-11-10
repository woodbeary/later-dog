import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { ComputerRuns, WAIT_IN_ONE_CALL_MS, type RunBox, type RunOutcome } from "./computer-runs.ts";

export interface ComputerRunRequest {
  botId: string;
  body: Record<string, unknown>;
  workingFolder: string | null;
  allowedRoots: readonly string[];
  home?: string;
  active?: () => boolean;
}

export interface ComputerRunDeps {
  runs: ComputerRuns;
  computer(botId: string, options?: { repository?: string; wanted?: () => boolean; budgetMs?: number }): Promise<{ box: RunBox; wasAsleep: boolean; rest(): Promise<void> }>;
  repositoryOf?(folder: string): string | null;
  now?(): number;
}

const GITHUB_REMOTE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

export function repositoryFromRemote(remote: string): string | null {
  const match = GITHUB_REMOTE.exec(remote.trim());
  return match && !match[1].includes("..") ? match[1] : null;
}

export function repositoryOf(folder: string): string | null {
  try {
    const remote = execFileSync("git", ["-C", folder, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] });
    return repositoryFromRemote(remote);
  } catch {
    return null;
  }
}

const busy = new Map<string, number>();
const LEAST_RUN_WAIT_MS = 5_000;
export const STILL_STARTING_TEXT = "Your cloud computer is still starting, so nothing was run yet. Call run_on_computer again with the same folder and command to keep waiting.";
const inside = (path: string, root: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

export function allowedFolder(requested: string, request: Pick<ComputerRunRequest, "workingFolder" | "allowedRoots" | "home">): string | null {
  const home = request.home ?? homedir();
  const folder = normalize(resolve(requested || request.workingFolder || ""));
  if (!requested && !request.workingFolder) return null;
  try { if (!lstatSync(folder).isDirectory()) return null; } catch { return null; }
  if (request.allowedRoots.some((root) => inside(folder, root))) return folder;
  const top = relative(home, folder).split("/")[0];
  return inside(folder, home) && top !== "" && !top.startsWith(".") ? folder : null;
}

export function outcomeText(outcome: RunOutcome): string {
  const lines: string[] = [];
  if (outcome.state === "running") lines.push(`Still running on your cloud computer (run_id ${outcome.id}).`);
  else if (outcome.state === "failed") lines.push(`Stopped on your cloud computer (run_id ${outcome.id}).`);
  else lines.push(`Finished on your cloud computer with exit code ${outcome.exitCode} (run_id ${outcome.id}).`);
  if (outcome.sentFiles) lines.push(`Sent ${outcome.sentFiles} changed file(s), ${Math.max(1, Math.round(outcome.sentBytes / 1024))} KB.`);
  if (outcome.broughtBack.length) lines.push(`Brought back ${outcome.broughtBack.length} file(s): ${outcome.broughtBack.slice(0, 20).join(", ")}${outcome.broughtBack.length > 20 ? ", …" : ""}.`);
  else if (outcome.state === "finished") lines.push("It changed no files here.");
  if (outcome.note) lines.push(outcome.note);
  lines.push("", "Output (end):", outcome.output.trim() || "(none)");
  return lines.join("\n");
}

export async function handleComputerRun(request: ComputerRunRequest, deps: ComputerRunDeps): Promise<{ status: number; text?: string; failed?: boolean; error?: string }> {
  const runId = typeof request.body.run_id === "string" ? request.body.run_id.trim() : "";
  const command = typeof request.body.command === "string" ? request.body.command.trim() : "";
  const record = runId ? deps.runs.record(request.botId, runId) : null;
  if (runId && !record) return { status: 404, error: `No run ${runId} for this dog.` };
  if (!record && !command) return { status: 400, error: "Give a command to run, or the run_id of a run that is still going." };
  if (command.length > 4000) return { status: 400, error: "The command is longer than 4,000 characters; put it in a script file in the folder and run that." };
  const folder = record ? record.folder : allowedFolder(typeof request.body.folder === "string" ? request.body.folder : "", request);
  if (!folder) return { status: 400, error: "Pass folder: an existing project folder in the home, such as your working folder." };
  const subdir = typeof request.body.subdir === "string" ? request.body.subdir : undefined;
  if (subdir && !inside(join(folder, subdir), folder)) return { status: 400, error: "subdir must be inside folder." };
  busy.set(request.botId, (busy.get(request.botId) ?? 0) + 1);
  let computer: Awaited<ReturnType<ComputerRunDeps["computer"]>> | null = null;
  let restAfter = false;
  try {
    const repository = record ? null : (deps.repositoryOf ?? repositoryOf)(folder);
    const now = deps.now ?? Date.now;
    const started = now();
    computer = await deps.computer(request.botId, { ...(repository ? { repository } : {}), ...(request.active ? { wanted: request.active } : {}), budgetMs: WAIT_IN_ONE_CALL_MS });
    if (request.active && !request.active()) {
      restAfter = !record && computer.wasAsleep;
      return { status: 409, error: "This turn ended while the cloud computer was starting, so nothing was run." };
    }
    const waitMs = Math.max(LEAST_RUN_WAIT_MS, WAIT_IN_ONE_CALL_MS - (now() - started));
    const outcome = record
      ? await deps.runs.finish(computer.box, record, undefined, waitMs)
      : await deps.runs.run(computer.box, { botId: request.botId, folder, subdir, command, restAfter: computer.wasAsleep, waitMs });
    restAfter = outcome.state !== "running" && Boolean(record ? record.restAfter : computer.wasAsleep);
    return { status: 200, text: outcomeText(outcome), failed: outcome.state === "failed" };
  } catch (error) {
    if ((error as { code?: unknown })?.code === "still_starting") return { status: 200, text: STILL_STARTING_TEXT };
    return { status: 502, error: error instanceof Error ? error.message : String(error) };
  } finally {
    const left = (busy.get(request.botId) ?? 1) - 1;
    if (left > 0) busy.set(request.botId, left); else busy.delete(request.botId);
    if (computer && restAfter && left === 0) await computer.rest();
  }
}
