export const FORMER_NAMES_KEPT = 6;

type Named = { name: string; formerNames?: readonly string[] };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function formerNamesAfterRename(bot: Named, nextName: string): string[] | undefined {
  const previous = bot.name.trim();
  if (!previous || sameName(previous, nextName)) return undefined;
  const kept = (bot.formerNames ?? []).filter((name) => !sameName(name, previous) && !sameName(name, nextName));
  return [previous, ...kept].slice(0, FORMER_NAMES_KEPT);
}

export function exchangeName(first: { name: string }, second: { name: string }): string {
  return `${first.name} ⇄ ${second.name}`;
}
