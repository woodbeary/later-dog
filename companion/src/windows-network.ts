import { execFile } from "node:child_process";

const SCRIPT =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "Get-NetConnectionProfile | ForEach-Object { $_.InterfaceAlias + [char]9 + $_.NetworkCategory }";

export function publicNetworkAliases(output: string): Set<string> {
  const aliases = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.lastIndexOf("\t");
    if (tab > 0 && line.slice(tab + 1).trim() === "Public") aliases.add(line.slice(0, tab));
  }
  return aliases;
}

const getNetConnectionProfile = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { timeout: 5_000, killSignal: "SIGKILL", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

const MAX_AGE_MS = 15_000;

export function createPublicNetworkCheck({
  platform = process.platform,
  run = getNetConnectionProfile,
  now = Date.now,
  maxAgeMs = MAX_AGE_MS,
}: {
  platform?: NodeJS.Platform;
  run?: () => Promise<string>;
  now?: () => number;
  maxAgeMs?: number;
} = {}): () => ReadonlySet<string> {
  let known: ReadonlySet<string> = new Set();
  let checkedAt = Number.NEGATIVE_INFINITY;
  let asking = false;
  return () => {
    if (platform !== "win32" || asking || now() - checkedAt < maxAgeMs) return known;
    asking = true;
    run()
      .then(
        (output) => { known = publicNetworkAliases(output); },
        () => { known = new Set(); },
      )
      .finally(() => {
        checkedAt = now();
        asking = false;
      });
    return known;
  };
}

export const publicNetworks = createPublicNetworkCheck();
