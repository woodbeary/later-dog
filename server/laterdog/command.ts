import { spawn } from "node:child_process";

export interface CommandResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
export interface CommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; maxBytes?: number }
export type CommandRunner = (binary: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;
export const runCommand: CommandRunner = (binary, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
  const output: Buffer[] = []; const errors: Buffer[] = [];
  let bytes = 0; let timedOut = false; let tooLarge = false;
  const maxBytes = options.maxBytes ?? 8_000_000;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs ?? 30_000);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), (options.timeoutMs ?? 30_000) + 5000);
  const collect = (target: Buffer[]) => (data: Buffer) => {
    bytes += data.length;
    if (bytes > maxBytes) { tooLarge = true; child.kill("SIGTERM"); return; }
    target.push(data);
  };
  child.stdout.on("data", collect(output)); child.stderr.on("data", collect(errors));
  child.on("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
  child.on("close", (code) => {
    clearTimeout(timer); clearTimeout(killTimer);
    resolve({ stdout: Buffer.concat(output).toString("utf8"), stderr: tooLarge ? "Command exceeded output limit" : Buffer.concat(errors).toString("utf8"), exitCode: tooLarge ? 125 : code ?? 124, timedOut });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
});
export function describeFailure(result: CommandResult, operation: string): string {
  // The last few stderr lines are what an operator needs ("environment not found", "Not signed in"); bounded so a verbose CLI cannot flood the event log.
  const detail = result.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 500);
  return `${operation} ${result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`}${detail ? `: ${detail}` : ""}`;
}
export function requireSuccess(result: CommandResult, operation: string): string {
  if (result.exitCode !== 0 || result.timedOut) throw new Error(describeFailure(result, operation));
  return result.stdout.trim();
}
/** Like requireSuccess but keeps stdout byte-for-byte; a trimmed unified diff loses the trailing newline `git apply` requires. */
export function requireOutput(result: CommandResult, operation: string): string {
  if (result.exitCode !== 0 || result.timedOut) throw new Error(describeFailure(result, operation));
  return result.stdout;
}
