import { statfsSync } from "node:fs";

export const TRANSFER_SPACE_MARGIN = 256 * 1024 ** 2;

export function freeVolumeBytes(path: string): number {
  const disk = statfsSync(path, { bigint: true });
  const free = disk.bavail * disk.bsize;
  return free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free);
}

export function totalVolumeBytes(path: string): number {
  const disk = statfsSync(path, { bigint: true });
  const total = disk.blocks * disk.bsize;
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
}
