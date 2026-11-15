import { HISTORY_SUMMARY_PURPOSE } from "./summary-usage.ts";

export function countsAsTurn(row: { purpose?: unknown }): boolean {
  return row.purpose !== HISTORY_SUMMARY_PURPOSE;
}
