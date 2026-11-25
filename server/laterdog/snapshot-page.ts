export const MESSAGE_PAGE_MAX = 200;
export const SNAPSHOT_PAGE_DEFAULT = MESSAGE_PAGE_MAX;

export function requestedPageSize(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) return null;
  return Math.min(size, MESSAGE_PAGE_MAX);
}

export function snapshotPageSize(raw: string | null): number | null {
  const size = requestedPageSize(raw);
  return size === undefined ? SNAPSHOT_PAGE_DEFAULT : size;
}
