import type { ProviderSnapshot } from "../contracts.ts";
import { execCli } from "../procs.ts";

export const CLI_VERSION_WAIT_MS = 8000;

export type CliVersion = { version: string } | { missing: true } | { starting: true } | { failed: true };

const NOT_THERE: ReadonlySet<string> = new Set(["ENOENT", "EACCES", "EPERM"]);

export function notThere(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_THERE.has(code);
}

export function unreadVersion(error: unknown): Exclude<CliVersion, { version: string }> {
  if (ranOutOfTime(error)) return { starting: true };
  return notThere(error) ? { missing: true } : { failed: true };
}

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
      if (error) return resolve(unreadVersion(error));
      const version = parse(stdout, stderr);
      resolve(version ? { version } : { failed: true });
    });
  });
}

export function unreadCli(cli: string, read: Exclude<CliVersion, { version: string }>): ProviderSnapshot {
  if ("starting" in read) return { state: "unavailable", reason: `\`${cli}\` is still starting`, starting: true };
  if ("failed" in read) return { state: "unavailable", reason: beingChecked(`\`${cli}\``), checkFailed: true };
  return { state: "unavailable", reason: `\`${cli}\` CLI not found`, missing: true };
}

export function programMissing(snapshot: ProviderSnapshot): boolean {
  return snapshot.state === "unavailable" && snapshot.missing === true;
}

export function checkUnknown(snapshot: ProviderSnapshot): boolean {
  return snapshot.state === "unavailable" && (snapshot.starting === true || snapshot.checkFailed === true);
}

export function beingChecked(name: string): string {
  return `${name} is still being checked`;
}

export function readingRuns(snapshot: ProviderSnapshot): boolean {
  return snapshot.state === "available" || checkUnknown(snapshot);
}

export function readingReady(snapshot: ProviderSnapshot): boolean {
  return readingRuns(snapshot) && snapshot.authenticated !== false;
}
