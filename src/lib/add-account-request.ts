// Opens Settings' Add account sheet from anywhere: the limit row, the model
// picker. With a kind, the sheet goes straight to that provider's sign-in.
export type AddAccountKind = "claudeAgent" | "codex";

const listeners = new Set<() => void>();
let pending: { kind?: AddAccountKind } | null = null;

export function requestAddAccount(kind?: AddAccountKind): void {
  pending = kind ? { kind } : {};
  for (const listener of listeners) listener();
}

export function subscribeAddAccount(open: (kind?: AddAccountKind) => void): () => void {
  const listener = () => {
    if (!pending) return;
    const { kind } = pending;
    pending = null;
    open(kind);
  };
  listeners.add(listener);
  listener();
  return () => { listeners.delete(listener); };
}
