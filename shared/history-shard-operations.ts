import {
  executeHistoryOperation as messages,
  historyOperationWrites as messageWrites,
} from "./history-message-operations.ts";
import {
  executeHistoryNativeOperation as native,
  historyNativeOperationWrites as nativeWrites,
} from "./history-native-operations.ts";
import type {
  HistoryOperation,
  HistoryAllocator,
} from "./history-shard-types.ts";
import type { HistorySql } from "./history-values.ts";
export type { HistoryOperation } from "./history-shard-types.ts";

export function historyOperationWrites(operation: HistoryOperation): boolean {
  return operation.op.startsWith("native.")
    ? nativeWrites(operation)
    : messageWrites(operation);
}

export function executeHistoryOperation(
  sql: HistorySql,
  thread: string,
  operation: HistoryOperation,
  allocate: HistoryAllocator,
): unknown {
  return operation.op.startsWith("native.")
    ? native(sql, thread, operation, allocate)
    : messages(sql, thread, operation, allocate);
}
