export interface Pinnable {
  id: string;
  pinned?: boolean;
  pinRank?: number;
}

function rankOf(bot: Pinnable): number {
  return typeof bot.pinRank === "number" && Number.isFinite(bot.pinRank) ? bot.pinRank : Number.MAX_SAFE_INTEGER;
}

export function pinnedInOrder<T extends Pinnable>(bots: readonly T[]): T[] {
  return bots
    .map((bot, index) => ({ bot, index }))
    .filter(({ bot }) => bot.pinned)
    .sort((a, b) => rankOf(a.bot) - rankOf(b.bot) || a.index - b.index)
    .map(({ bot }) => bot);
}

export function nextPinRank(bots: readonly Pinnable[]): number {
  return pinnedInOrder(bots).reduce((highest, bot) => (rankOf(bot) === Number.MAX_SAFE_INTEGER ? highest : Math.max(highest, rankOf(bot))), 0) + 1;
}

export function pinRankChange(bot: Pinnable | null | undefined, pinned: unknown, bots: readonly Pinnable[]): { pinRank?: number } {
  if (!bot || typeof pinned !== "boolean") return {};
  if (!pinned) return { pinRank: undefined };
  return bot.pinned ? {} : { pinRank: nextPinRank(bots) };
}

export function rankedPins(bots: readonly Pinnable[], order: readonly string[]): Map<string, number> {
  const pinned = pinnedInOrder(bots).map((bot) => bot.id);
  const listed = order.filter((id, at) => order.indexOf(id) === at && pinned.includes(id));
  const rest = pinned.filter((id) => !listed.includes(id));
  return new Map([...listed, ...rest].map((id, index) => [id, index + 1]));
}

export function loosePinRanks(bots: readonly Pinnable[]): Map<string, number> {
  const pinned = pinnedInOrder(bots);
  let next = nextPinRank(bots);
  const ranks = new Map<string, number>();
  for (const bot of pinned) if (rankOf(bot) === Number.MAX_SAFE_INTEGER) ranks.set(bot.id, next++);
  return ranks;
}
