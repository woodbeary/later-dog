import type { ProviderSnapshot } from "../contracts.ts";
import { execCli } from "../procs.ts";

export const CLI_VERSION_WAIT_MS = 8000;

export type CliVersion = { version: string } | { missing: true } | { starting: true };

export function ranOutOfTime(error: unknown): boolean {
  const failure = error as { killed?: unknown; signal?: unknown } | null;
  return Boolean(failure && failure.killed === true && failure.signal === "SIGTERM");
}

export function readCliVersion(
  cli: string,
  env: NodeJS.ProcessEnv,
  parse: (stdout: string, stderr: string) => string | null = (stdout) => stdout.trim() || null,
  waitMs = CLI_VERSION_WAIT_MS,
): Promise<CliVersion> {
  return new Promise((resolve) => {
    execCli(cli, ["--version"], { timeout: waitMs, env }, (error, stdout, stderr = "") => {
      if (error) return resolve(ranOutOfTime(error) ? { starting: true } : { missing: true });
      const version = parse(stdout, stderr);
      resolve(version ? { version } : { missing: true });
    });
  });
}

export function unreadCli(cli: string, read: Exclude<CliVersion, { version: string }>): ProviderSnapshot {
  return "starting" in read
    ? { state: "unavailable", reason: `\`${cli}\` is still starting`, starting: true }
    : { state: "unavailable", reason: `\`${cli}\` CLI not found` };
}
