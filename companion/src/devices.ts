import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDataDir, writeFileAtomic } from "./state.ts";

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  cloudDesktopAccess: boolean;
  browserControlAccess: boolean;
  accountPaired?: true;
}

export type PublicDevice = Omit<DeviceRecord, "tokenHash">;

export interface PairingWindow {
  code: string;
  token: string;
  expiresAt: number;
  attemptsLeft: number;
  account?: true;
}

interface PairingReplay {
  requestId: string;
  credentialHash: string;
  expiresAt: number;
  result: { device: PublicDevice; token: string };
}

const DEVICES_FILE = join(DATA_DIR, "devices.json");
export const PAIRING_TTL_MS = 120_000;
export const MAX_PAIRING_ATTEMPTS = 5;
export const MAX_DEVICES = 20;
const LAST_SEEN_WRITE_MS = 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function sameCredential(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function cleanDeviceName(raw: unknown): string {
  const name = String(raw ?? "")
    // oxlint-disable-next-line no-control-regex -- strips control characters from a display name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 60);
  return name || "Companion";
}

const timestamp = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

function normalizeDevice(record: Partial<DeviceRecord> & { id: string; tokenHash: string }): DeviceRecord {
  const createdAt = timestamp(record.createdAt, Date.now());
  return {
    id: record.id,
    tokenHash: record.tokenHash,
    name: cleanDeviceName(record.name),
    createdAt,
    lastSeenAt: timestamp(record.lastSeenAt, createdAt),
    cloudDesktopAccess: record.cloudDesktopAccess === true,
    browserControlAccess: record.browserControlAccess === true,
    ...(record.accountPaired === true ? { accountPaired: true } : {}),
  };
}

export class DeviceRegistry {
  private devices: DeviceRecord[] = [];
  private window: PairingWindow | null = null;
  private replay: PairingReplay | null = null;
  private replayExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenWrites = new Map<string, number>();

  constructor() {
    try {
      const parsed = JSON.parse(readFileSync(DEVICES_FILE, "utf8"));
      if (Array.isArray(parsed?.devices)) {
        this.devices = parsed.devices
          .filter(
            (d: unknown): d is Partial<DeviceRecord> & { id: string; tokenHash: string } =>
              typeof (d as DeviceRecord)?.id === "string" &&
              typeof (d as DeviceRecord)?.tokenHash === "string",
          )
          .map(normalizeDevice);
      }
    } catch {}
  }

  private persist() {
    ensureDataDir();
    writeFileAtomic(DEVICES_FILE, JSON.stringify({ devices: this.devices }, null, 2));
  }

  list(): PublicDevice[] {
    return this.devices.map(({ tokenHash: _tokenHash, ...rest }) => rest);
  }

  count(): number {
    return this.devices.length;
  }

  pairing(): PairingWindow | null {
    if (this.window && this.window.expiresAt <= Date.now()) this.window = null;
    return this.window;
  }

  openPairing(): PairingWindow {
    this.clearReplay();
    this.window = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      token: `laterdog_pair_${randomBytes(32).toString("base64url")}`,
      expiresAt: Date.now() + PAIRING_TTL_MS,
      attemptsLeft: MAX_PAIRING_ATTEMPTS,
    };
    return this.window;
  }

  openAccountPairing(): PairingWindow | null {
    if (this.pairing()) return null;
    const window = this.openPairing();
    window.code = "";
    window.account = true;
    return window;
  }

  closePairing(expectedToken?: string): boolean {
    if (expectedToken !== undefined && this.pairing()?.token !== expectedToken) return false;
    this.window = null;
    this.clearReplay();
    return true;
  }

  private clearReplay() {
    this.replay = null;
    if (this.replayExpiryTimer) clearTimeout(this.replayExpiryTimer);
    this.replayExpiryTimer = null;
  }

  redeem(
    credential: string,
    name: unknown,
    pairRequestId?: unknown,
  ): { device: PublicDevice; token: string } | { error: string } {
    const presented = String(credential ?? "");
    const requestId =
      typeof pairRequestId === "string" && /^[A-Za-z0-9._-]{16,128}$/.test(pairRequestId)
        ? pairRequestId
        : null;

    if (this.replay && this.replay.expiresAt <= Date.now()) this.clearReplay();
    if (
      requestId &&
      this.replay &&
      sameCredential(this.replay.requestId, requestId) &&
      sameDigest(this.replay.credentialHash, sha256(presented))
    ) {
      return this.replay.result;
    }

    const window = this.pairing();
    if (!window) return { error: "no pairing is in progress — open Phone settings on your computer" };
    if (!(window.code && sameCredential(window.code, presented)) && !sameCredential(window.token, presented)) {
      window.attemptsLeft -= 1;
      if (window.attemptsLeft <= 0) {
        this.closePairing();
        return { error: "too many incorrect codes — start pairing again" };
      }
      return { error: "that pairing credential is not right" };
    }
    if (this.devices.length >= MAX_DEVICES) return { error: "too many paired devices — remove one first" };
    this.window = null;

    const token = `laterdog_${randomBytes(32).toString("base64url")}`;
    const device: DeviceRecord = {
      id: randomUUID(),
      name: cleanDeviceName(name),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      cloudDesktopAccess: false,
      browserControlAccess: false,
      ...(window.account ? { accountPaired: true as const } : {}),
    };
    this.devices.push(device);
    try {
      this.persist();
    } catch (e) {
      this.devices.pop();
      return { error: `could not save the pairing: ${(e as Error).message}` };
    }
    const { tokenHash: _tokenHash, ...pub } = device;
    const result = { device: pub, token };
    if (requestId) {
      this.replay = {
        requestId,
        credentialHash: sha256(presented),
        expiresAt: window.expiresAt,
        result,
      };
      this.replayExpiryTimer = setTimeout(
        () => this.clearReplay(),
        Math.max(0, window.expiresAt - Date.now()),
      );
      this.replayExpiryTimer.unref?.();
    }
    return result;
  }

  authenticate(token: string | undefined): DeviceRecord | null {
    if (!token) return null;
    const hash = sha256(token);
    const device = this.devices.find((d) => sameDigest(d.tokenHash, hash));
    if (!device) return null;
    const now = Date.now();
    if (now - (this.lastSeenWrites.get(device.id) ?? 0) > LAST_SEEN_WRITE_MS) {
      device.lastSeenAt = now;
      this.lastSeenWrites.set(device.id, now);
      try {
        this.persist();
      } catch {}
    }
    return device;
  }

  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.lastSeenWrites.delete(id);
    this.persist();
    return true;
  }

  revokeAccountDevices(): string[] {
    const before = this.devices;
    const removed = before.filter(device => device.accountPaired).map(device => device.id);
    this.devices = before.filter(device => !device.accountPaired);
    try { this.persist(); } catch (error) { this.devices = before; throw error; }
    if (this.window?.account) this.closePairing(this.window.token);
    if (this.replay && removed.includes(this.replay.result.device.id)) this.clearReplay();
    for (const id of removed) this.lastSeenWrites.delete(id);
    return removed;
  }

  setCloudDesktopAccess(id: string, allowed: boolean): boolean {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return false;
    const previous = device.cloudDesktopAccess;
    device.cloudDesktopAccess = allowed;
    try {
      this.persist();
    } catch (error) {
      device.cloudDesktopAccess = previous;
      throw error;
    }
    return true;
  }

  setBrowserControlAccess(id: string, allowed: boolean): boolean {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return false;
    const previous = device.browserControlAccess;
    device.browserControlAccess = allowed;
    try {
      this.persist();
    } catch (error) {
      device.browserControlAccess = previous;
      throw error;
    }
    return true;
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || undefined : undefined;
}
