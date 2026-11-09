import type { Refusal } from "./auth";
import { SNAPSHOT_TTL_MS, TTL_MARGIN_MS } from "./environments";
import { DAY } from "./trial";

export const HOLD_KEY = /^[a-f0-9]{24}$/;
export const MAX_HOLDS = 64;
export const HOLD_FUTURE_SLACK_MS = DAY;

export type Holds = Record<string, number>;
export type HoldOp = "reset" | "update" | "delete";

export interface HoldView {
  held: number;
  writtenAt: string;
  captured: boolean;
  snapshotExpiresAt?: string;
}

export type HoldFrame = { channel: "hold"; key: string; writtenAt: number } | { channel: "release"; key: string; through: number };

export function parseHoldFrame(frame: unknown): HoldFrame | null {
  if (typeof frame !== "object" || frame === null) return null;
  const value = frame as Record<string, unknown>;
  if (typeof value.key !== "string" || !HOLD_KEY.test(value.key)) return null;
  const time = (raw: unknown) => typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (value.channel === "hold") { const writtenAt = time(value.writtenAt); return writtenAt === null ? null : { channel: "hold", key: value.key, writtenAt }; }
  if (value.channel === "release") { const through = time(value.through); return through === null ? null : { channel: "release", key: value.key, through }; }
  return null;
}

export const latestWrite = (holds: Holds | undefined): number | null => {
  const times = Object.values(holds ?? {});
  return times.length ? Math.max(...times) : null;
};

export const snapshotUsableUntil = (snapshotAt: number) => snapshotAt + SNAPSHOT_TTL_MS - TTL_MARGIN_MS;

export function capturedBySnapshot(holds: Holds | undefined, snapshotAt: number | undefined, now: number): boolean {
  const latest = latestWrite(holds);
  if (latest === null) return true;
  return snapshotAt !== undefined && snapshotAt >= latest && now < snapshotUsableUntil(snapshotAt);
}

export function holdView(holds: Holds | undefined, snapshotAt: number | undefined, now: number): HoldView | undefined {
  const latest = latestWrite(holds);
  if (latest === null) return undefined;
  return {
    held: Object.keys(holds!).length,
    writtenAt: new Date(latest).toISOString(),
    captured: capturedBySnapshot(holds, snapshotAt, now),
    ...(snapshotAt === undefined ? {} : { snapshotExpiresAt: new Date(snapshotAt + SNAPSHOT_TTL_MS).toISOString() }),
  };
}

export function addHold(holds: Holds | undefined, key: string, writtenAt: number, now: number): { ok: true; holds: Holds } | { ok: false; refusal: Refusal } {
  if (writtenAt > now + HOLD_FUTURE_SLACK_MS) return { ok: false, refusal: { status: 400, code: "bad_hold", message: "That workspace time is in the future." } };
  const next = { ...(holds ?? {}) };
  if (!(key in next) && Object.keys(next).length >= MAX_HOLDS) {
    return { ok: false, refusal: { status: 409, code: "too_many_holds", message: `This computer already holds ${MAX_HOLDS} workspaces; bring some home first.` } };
  }
  next[key] = Math.max(next[key] ?? 0, writtenAt);
  return { ok: true, holds: next };
}

export function releaseHold(holds: Holds | undefined, key: string, through: number): { ok: true; holds: Holds } | { ok: false; refusal: Refusal } {
  const next = { ...(holds ?? {}) };
  const held = next[key];
  if (held === undefined) return { ok: true, holds: next };
  if (held > through) return { ok: false, refusal: { status: 409, code: "newer_work", message: "The workspace changed after it was copied home, so the computer keeps holding it." } };
  delete next[key];
  return { ok: true, holds: next };
}

export function holdRefusal(op: HoldOp, holds: Holds | undefined, snapshotAt: number | undefined, now: number): Refusal | null {
  const latest = latestWrite(holds);
  if (latest === null) return null;
  const count = Object.keys(holds!).length;
  const what = `${count} dog workspace${count === 1 ? "" : "s"} that live${count === 1 ? "s" : ""} only on this computer`;
  if (op === "reset") {
    if (capturedBySnapshot(holds, snapshotAt, now)) return null;
    return { status: 409, code: "workspace_held", message: `This computer holds ${what}, and its last snapshot is older than their last change. Put it to sleep first so a fresh snapshot keeps them, or bring them home, then reset.` };
  }
  if (op === "update") {
    return { status: 409, code: "workspace_held", message: `This computer holds ${what}. Updating carries only the dog's home folder, so bring the workspaces home first, then update.` };
  }
  return { status: 409, code: "workspace_held", message: `This computer holds ${what}. Deleting it would delete its snapshot too, so bring the workspaces home first, then delete.` };
}
