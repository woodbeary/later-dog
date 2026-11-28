export type HistoryExportRequest = (
  route: string,
  body?: unknown,
) => Promise<unknown>;
export function portableHistorySnapshot(
  request: HistoryExportRequest,
  generation: string,
  source: string,
  target: string,
  receiptAccess: {
    receiptBatch: (q: unknown) => Promise<unknown>;
    getReceipt: (sha: string) => Promise<ReadableStream<Uint8Array>>;
  },
): Promise<void>;
export function portableHistoryContents(
  request: HistoryExportRequest,
  generation: string,
): Promise<{ chats: number; bytes: number }>;
