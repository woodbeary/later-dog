import { base64url, hex, hmacSha256 } from "./encoding.ts";

export const MACHINE_LABEL = /^h[0-9a-f]{24}$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HOST_SUFFIX = /^-[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export interface HomeIdentity {
  accountId: string;
  machineId: string;
  host: string;
  origin: string;
}

export function validAccountId(accountId: string): boolean {
  return ACCOUNT_ID.test(accountId);
}

export function validHostSuffix(hostSuffix: string): boolean {
  return HOST_SUFFIX.test(hostSuffix);
}

export async function homeIdentity(secret: string, accountId: string, hostSuffix: string): Promise<HomeIdentity> {
  if (!validAccountId(accountId)) throw new Error("invalid account id");
  if (!validHostSuffix(hostSuffix)) throw new Error("invalid home host suffix");
  const machineId = `h${hex(await hmacSha256(secret, `laterdog-home:machine:${accountId}`)).slice(0, 24)}`;
  const host = `${machineId}${hostSuffix}`;
  return { accountId, machineId, host, origin: `https://${host}` };
}

export async function bootstrapSecret(secret: string, machineId: string): Promise<string> {
  return base64url(await hmacSha256(secret, `laterdog-home:bootstrap:${machineId}`));
}

export function machineFromHost(hostname: string, hostSuffix: string): string | null {
  const host = hostname.toLowerCase();
  const suffix = hostSuffix.toLowerCase();
  if (!validHostSuffix(suffix) || !host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return MACHINE_LABEL.test(label) ? label : null;
}
