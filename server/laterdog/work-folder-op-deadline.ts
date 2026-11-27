export const METADATA_OPERATION_MS = 12_000;
export const DATA_OPERATION_MS = 55_000;
const DATA_OPERATIONS = new Set(["read", "write", "flush", "fsync", "release", "create", "open"]);

export function operationDeadline(op: string): number {
  return DATA_OPERATIONS.has(op) ? DATA_OPERATION_MS : METADATA_OPERATION_MS;
}

export function withOperationDeadline<T>(op: string, work: Promise<T>, deadlineMs = operationDeadline(op)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Working folder ${op} did not answer within ${deadlineMs} ms`), { code: "ETIMEDOUT" })), deadlineMs);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
