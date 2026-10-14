const listeners = new Set<() => void>();
let open = false;

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function requestUpdateDialog(): void {
  set(true);
}

export function dismissUpdateDialog(): void {
  set(false);
}

export function updateDialogOpen(): boolean {
  return open;
}

export function subscribeUpdateDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
