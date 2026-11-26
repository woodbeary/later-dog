import type {
  HistoryThreadProof,
  HistoryRow,
  HistoryTable,
} from "../../../../shared/history-migration.ts";

export type HistoryMode = "legacy" | "dual" | "remote" | "held";
export interface Placement {
  mode: HistoryMode;
  generation: string | null;
  revision: number;
}
export interface ShardAddress {
  generation: string;
  threadId: string;
  ordinal: number;
}
export interface ThreadPage {
  threads: string[];
  next: string | null;
}
export interface ImportedPage {
  rows: HistoryRow[];
  next: string | null;
}
export type ImportCommand =
  | { op: "reset"; loadId: string; expectedLoadId: string | null }
  | { op: "import"; loadId: string; table: HistoryTable; rows: HistoryRow[] }
  | { op: "seal"; loadId: string; proof: HistoryThreadProof };
export type PageCommand = {
  op: "page";
  table: HistoryTable;
  after?: string;
  limit?: number;
};

export function requireTenant(stable: string): void {
  if (!/^[0-9a-f]{64}$/.test(stable)) throw Error("Invalid home identity");
}
export function requireGeneration(generation: string): void {
  if (
    typeof generation !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(generation)
  )
    throw Error("Invalid history generation");
}
export function requireThread(thread: string): void {
  if (
    typeof thread !== "string" ||
    !thread ||
    thread.includes("\0") ||
    new TextEncoder().encode(thread).length > 4096
  )
    throw Error("Invalid history thread");
}
export function shardName(
  stable: string,
  generation: string,
  threadId: string,
): string {
  return JSON.stringify([stable, generation, threadId]);
}
