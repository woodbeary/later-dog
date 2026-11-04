import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { ComputerRuns, type RunBox, type RunOutcome } from "./computer-runs.ts";

export interface ComputerRunRequest {
  botId: string;
  body: Record<string, unknown>;
  workingFolder: string | null;
  allowedRoots: readonly string[];
  home?: string;
}

export interface ComputerRunDeps {
  runs: ComputerRuns;
  computer(botId: string): Promise<{ box: RunBox; wasAsleep: boolean; rest(): Promise<void> }>;
}

const busy = new Map<string, number>();
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
    computer = await deps.computer(request.botId);
    const outcome = record
      ? await deps.runs.finish(computer.box, record)
      : await deps.runs.run(computer.box, { botId: request.botId, folder, subdir, command, restAfter: computer.wasAsleep });
    restAfter = outcome.state !== "running" && Boolean(record ? record.restAfter : computer.wasAsleep);
    return { status: 200, text: outcomeText(outcome), failed: outcome.state === "failed" || (outcome.exitCode ?? 0) !== 0 };
  } catch (error) {
    return { status: 502, error: error instanceof Error ? error.message : String(error) };
  } finally {
    const left = (busy.get(request.botId) ?? 1) - 1;
    if (left > 0) busy.set(request.botId, left); else busy.delete(request.botId);
    if (computer && restAfter && left === 0) await computer.rest();
  }
}
