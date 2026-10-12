import { execFile } from "node:child_process";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, join } from "node:path";

const VIRTUAL_INTERFACE =
  /^(utun|tun|tap|bridge|br-|vmnet|vboxnet|virbr|veth|docker|cni|flannel|lxc|lxd|zt|wg|tailscale|awdl|llw|feth|anpi)|vethernet|virtual|vmware|hyper-v|wsl|zerotier|vpn|loopback|bluetooth/i;

const PHYSICAL_INTERFACE = /^(en|eth|wl)[a-z0-9]*$|^(wi-?fi|wlan|ethernet)\b/i;

const interfaceRank = (name: string): number => {
  if (VIRTUAL_INTERFACE.test(name)) return 2;
  if (PHYSICAL_INTERFACE.test(name)) return 0;
  return 1;
};

export function lanAddresses(interfaces = networkInterfaces()): string[] {
  return lanInterfaces(interfaces).map((entry) => entry.address);
}

export function lanInterfaces(interfaces = networkInterfaces()): Array<{ name: string; address: string }> {
  const found: Array<{ rank: number; name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      found.push({ rank: interfaceRank(name), name, address: entry.address });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map(({ name, address }) => ({ name, address }));
}

export function tailscaleAddress(addresses: string[] = lanAddresses()): string | null {
  for (const address of addresses) {
    const [first, second] = address.split(".").map(Number);
    if (first === 100 && second >= 64 && second <= 127) return address;
  }
  return null;
}

let cachedTailnetName: string | null = null;
let activeTailnetRefresh: Promise<void> | null = null;

export function tailnetName(): string | null {
  return cachedTailnetName;
}

export function tailscaleCandidates(home = homedir()): string[] {
  return [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    join(home, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale"),
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/run/current-system/sw/bin/tailscale",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
    "tailscale",
  ];
}

const TAILSCALE_BUDGET_MS = 5000;

export const searchPath = (): string =>
  [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(delimiter);

export const tailscaleEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: searchPath(),
  TAILSCALE_BE_CLI: "1",
});

async function refreshTailnetNameOnce(
  onAttempt?: (cli: string, outcome: string) => void,
): Promise<void> {
  const deadline = Date.now() + TAILSCALE_BUDGET_MS;
  for (const cli of tailscaleCandidates()) {
    const left = deadline - Date.now();
    if (left <= 0) {
      onAttempt?.(cli, "skipped — out of time looking for the Tailscale CLI");
      continue;
    }
    const name = await new Promise<string | null>((resolve) => {
      execFile(
        cli,
        ["status", "--json"],
        {
          timeout: Math.max(250, left),
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
          env: tailscaleEnvironment(),
        },
        (error, stdout) => {
          if (error) {
            onAttempt?.(cli, error.message.split("\n")[0]);
            return resolve(null);
          }
          try {
            const dns = JSON.parse(stdout)?.Self?.DNSName;
            const trimmed = typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null;
            onAttempt?.(cli, trimmed ? `ok: ${trimmed}` : "ran, but no MagicDNS name in status");
            resolve(trimmed);
          } catch {
            onAttempt?.(cli, /Tailscale GUI failed to start/i.test(stdout)
              ? "exited successfully in GUI mode instead of CLI mode"
              : "exited successfully, but status output was not JSON");
            resolve(null);
          }
        },
      );
    });
    if (name) {
      cachedTailnetName = name;
      return;
    }
  }
  cachedTailnetName = null;
}

export function refreshTailnetName(
  onAttempt?: (cli: string, outcome: string) => void,
): Promise<void> {
  if (activeTailnetRefresh) return activeTailnetRefresh;
  let refresh: Promise<void>;
  refresh = refreshTailnetNameOnce(onAttempt).finally(() => {
    if (activeTailnetRefresh === refresh) activeTailnetRefresh = null;
  });
  activeTailnetRefresh = refresh;
  return refresh;
}
