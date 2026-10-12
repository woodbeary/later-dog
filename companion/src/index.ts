#!/usr/bin/env node
import { createServer } from "node:http";

import { createAddressWatcher } from "./advertise-watch.ts";
import { createControlServer, hostCandidates } from "./control.ts";
import { createConnectedDeviceTracker } from "./connected-devices.ts";
import { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import { lanAddresses, refreshTailnetName, tailnetName, tailscaleAddress } from "./listener.ts";
import {
  advertisableAddresses,
  clampBytes,
  defaultHostName,
  dnsLabel,
  MdnsResponder,
  type ServiceInfo,
} from "./mdns.ts";
import { notifyDeviceRevoked } from "./harness-notice.ts";
import { createProxyHandler } from "./proxy.ts";
import { companionOriginSocket, listenCompanionOrigin } from "./origin.ts";
import { normalizedPhoneSecretPublicKey } from "./phone-secret-key.ts";

const parentPort = (process as NodeJS.Process & {
  parentPort?: { on(event: "message", listener: (event: { data?: unknown }) => void): void };
}).parentPort;
let mutationToken: string | null = null;
parentPort?.on("message", ({ data }) => {
  if (!data || typeof data !== "object") return;
  const message = data as Record<string, unknown>;
  if (message.type !== "laterdog:companion-mutation-token") return;
  if (typeof message.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.token)) {
    mutationToken = message.token;
  }
});

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
};

const HARNESS_PORT = num(process.env.LATERDOG_SERVER_PORT, 8799);
const WEBHOOK_PORT = num(process.env.LATERDOG_WEBHOOK_PORT, HARNESS_PORT + 1);
const COMPANION_PORT = num(process.env.LATERDOG_COMPANION_PORT, 8810);
const CONTROL_PORT = num(process.env.LATERDOG_CONTROL_PORT, 8811);
const SERVICE_TYPE = "_laterdog._tcp";
let hostedUrl = hostedCompanionUrl(process.env.LATERDOG_COMPANION_HOSTED_URL);
const PRIVATE_ORIGIN = companionOriginSocket(process.env.LATERDOG_COMPANION_INTERNAL_ORIGIN);
const SECRET_PUBLIC_KEY = normalizedPhoneSecretPublicKey(
  process.env.LATERDOG_PHONE_SECRET_PUBLIC_KEY ?? "",
);

const HARNESS_PORTS = new Map([
  [HARNESS_PORT, "the harness itself"],
  [WEBHOOK_PORT, "the harness's webhook receiver"],
]);

const conflict = (name: string, port: number): string | null => {
  const owner = HARNESS_PORTS.get(port);
  return owner ? `${name} is set to port ${port}, which is ${owner}` : null;
};

let cachedName = process.env.LATERDOG_COMPANION_NAME?.trim() || "";

const machineName = (): string => cachedName || "later.dog";

async function refreshMachineName(): Promise<void> {
  if (cachedName) return;
  try {
    const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const config = (await res.json()) as { profile?: { name?: string } };
    const owner = config.profile?.name?.trim();
    if (owner) cachedName = `${owner}'s computer`;
  } catch {}
}

const devices = new DeviceRegistry();
const mdns = new MdnsResponder();

const watcher = createAddressWatcher({
  addresses: advertisableAddresses,
  advertise: () => mdns.advertise(service()),
  withdraw: () => mdns.stop(),
  log: (line) => console.log(`bonjour: ${line}`),
});

const service = (): ServiceInfo => ({
  name: dnsLabel(machineName()),
  type: SERVICE_TYPE,
  port: COMPANION_PORT,
  host: defaultHostName(),
  addresses: advertisableAddresses(),
  txt: ["v=1", `name=${clampBytes(machineName(), 200)}`],
});

const connectedDevices = createConnectedDeviceTracker();
const proxy = createProxyHandler({
    harnessPort: HARNESS_PORT,
    mutationToken: parentPort ? () => mutationToken : undefined,
    authenticate: (token) => devices.authenticate(token),
    redeem: (code, deviceName, pairRequestId) => devices.redeem(code, deviceName, pairRequestId),
    serverName: machineName,
    hosts: () => hostCandidates(),
    endpoints: () => companionEndpointCandidates(COMPANION_PORT, undefined, undefined, hostedUrl),
    connected: connectedDevices.open,
  });
const companion = createServer(proxy);
companion.on("upgrade", proxy.upgrade);
const managedOrigin = PRIVATE_ORIGIN ? createServer(proxy) : null;
managedOrigin?.on("upgrade", proxy.upgrade);

const control = createControlServer({
  devices,
  companionPort: COMPANION_PORT,
  secretPublicKey: () => SECRET_PUBLIC_KEY,
  hostedUrl: () => hostedUrl,
  setHostedUrl: (next) => {
    hostedUrl = next;
  },
  discovery: () => ({ advertising: mdns.advertising, name: service().name }),
  connectedDeviceIds: connectedDevices.ids,
  disconnectDevice: (deviceId) => {
    connectedDevices.disconnect(deviceId);
    proxy.disconnectDevice(deviceId);
  },
  revoked: (deviceId) => {
    if (parentPort && !mutationToken) return;
    void notifyDeviceRevoked({ harnessPort: HARNESS_PORT, deviceId, mutationToken: mutationToken ?? undefined });
  },
  refreshTailscale: () => refreshTailnetName(),
});

const listen = (server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      const hint = ` — another copy of the companion may already be running; ${
        port === COMPANION_PORT ? "LATERDOG_COMPANION_PORT" : "LATERDOG_CONTROL_PORT"
      } chooses a different one`;
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use${hint}`)
          : error,
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.warn(`companion: error on ${host}:${port} — ${error.message}`);
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

async function main(): Promise<void> {
  const clash =
    conflict("LATERDOG_COMPANION_PORT", COMPANION_PORT) ?? conflict("LATERDOG_CONTROL_PORT", CONTROL_PORT);
  if (clash) throw new Error(`${clash}. Pick another port.`);

  if (COMPANION_PORT === CONTROL_PORT) {
    throw new Error(
      `LATERDOG_COMPANION_PORT and LATERDOG_CONTROL_PORT are both port ${COMPANION_PORT}, and they cannot share one: ` +
        `the first is open to your network and the second must never be. Pick another port.`,
    );
  }

  await listen(control, CONTROL_PORT, "127.0.0.1");
  await listen(companion, COMPANION_PORT, "0.0.0.0");
  if (managedOrigin && PRIVATE_ORIGIN) {
    await listenCompanionOrigin(managedOrigin, PRIVATE_ORIGIN);
  }

  await refreshMachineName();

  const tailscaleTried: string[] = [];
  await refreshTailnetName((cli, outcome) => tailscaleTried.push(`  ${cli} — ${outcome}`)).catch(() => {});

  await watcher.check();
  watcher.start();

  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const reach = tailnetName() ?? tailscale ?? addresses[0];
  console.log(`companion  http://0.0.0.0:${COMPANION_PORT}  →  harness 127.0.0.1:${HARNESS_PORT}`);
  console.log(`pair here  http://127.0.0.1:${CONTROL_PORT}`);
  if (reach) console.log(`on your phone, enter  ${reach}:${COMPANION_PORT}`);
  if (tailscale && !tailnetName()) {
    console.log("no MagicDNS name found. Tailscale CLI attempts:");
    for (const line of tailscaleTried) console.log(line);
  }
}

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} — stopping`);
  watcher.stop();
  await mdns.stop().catch(() => {});
  companion.closeAllConnections?.();
  control.closeAllConnections?.();
  managedOrigin?.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((r) => companion.close(() => r())),
    new Promise<void>((r) => control.close(() => r())),
    ...(managedOrigin ? [new Promise<void>((r) => managedOrigin.close(() => r()))] : []),
  ]);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
