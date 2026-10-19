export function dogCanAct<T extends object>(bot: T | null | undefined): bot is T {
  return bot != null;
}
