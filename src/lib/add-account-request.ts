import type { AccountEngine } from "../../shared/account-engines";

export type AddAccountKind = Extract<AccountEngine, "claudeAgent" | "codex" | "grokAgent">;
export type AddAccountRequest = { kind?: AddAccountKind; instanceId?: undefined } | { instanceId: string; kind?: undefined };

const listeners = new Set<() => void>();
let pending: AddAccountRequest | null = null;

function ask(request: AddAccountRequest): void {
  pending = request;
  for (const listener of listeners) listener();
}

export function requestAddAccount(kind?: AddAccountKind): void {
  ask(kind ? { kind } : {});
}

export function requestAccountSignIn(instanceId: string): void {
  ask({ instanceId });
}

export function subscribeAddAccount(open: (request: AddAccountRequest) => void): () => void {
  const listener = () => {
    if (!pending) return;
    const request = pending;
    pending = null;
    open(request);
  };
  listeners.add(listener);
  listener();
  return () => { listeners.delete(listener); };
}
