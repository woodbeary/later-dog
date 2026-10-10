const listeners = new Set<() => void>();
let pending = false;

export function requestAddAccount(): void {
  pending = true;
  for (const listener of listeners) listener();
}

export function subscribeAddAccount(open: () => void): () => void {
  const listener = () => {
    if (!pending) return;
    pending = false;
    open();
  };
  listeners.add(listener);
  listener();
  return () => { listeners.delete(listener); };
}
