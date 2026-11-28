import type { HistoryTable } from "./history-migration.ts";
export type HistoryOperation = { op: string; [field: string]: unknown };
export type HistoryAllocator = (table: HistoryTable) => string;
