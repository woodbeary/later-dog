import { readCommandReceipt, withCommandReceipt } from "./message-db.ts";

export interface Command {
  kind: string;
  key: string;
}

export interface CommandReceipt<T = unknown> {
  kind: string;
  key: string;
  at: number;
  result: T;
}

export function runCommand<T>(command: Command, apply: () => T, now: () => number = Date.now): T {
  const { result } = withCommandReceipt(
    command.kind,
    command.key,
    () => JSON.stringify(apply() ?? null),
    now(),
  );
  return JSON.parse(result) as T;
}

export function commandReceipt<T = unknown>(kind: string, key: string): CommandReceipt<T> | null {
  const stored = readCommandReceipt(kind, key);
  if (!stored) return null;
  return { kind: stored.kind, key: stored.key, at: stored.at, result: JSON.parse(stored.result) as T };
}
