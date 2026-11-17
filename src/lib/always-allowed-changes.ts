const changes = new EventTarget();

export function announceAlwaysAllowedChange(botId: string): void {
  changes.dispatchEvent(new CustomEvent<string>("change", { detail: botId }));
}

export function onAlwaysAllowedChange(botId: string, then: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<string>).detail === botId) then();
  };
  changes.addEventListener("change", listener);
  return () => changes.removeEventListener("change", listener);
}
