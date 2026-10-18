export interface MainDogCandidate {
  id: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  section?: string;
  createdAt?: number;
}

export const MAIN_DOG_DELETE_REFUSAL = "This is your main dog. Make another dog the main dog before deleting it.";
export const MAIN_DOG_REQUIRED = "There is always one main dog. Make another dog the main dog instead.";

const sectionKey = (section?: string): string => section?.trim() || "";

export function mainDogId(
  bots: readonly MainDogCandidate[],
  pointer?: string | null,
  sectionOrder: readonly string[] = [],
): string | null {
  if (pointer && bots.some((bot) => bot.id === pointer)) return pointer;
  const sidebarRank = (bot: MainDogCandidate): number => {
    const key = sectionKey(bot.section);
    if (!key) return -1;
    const at = sectionOrder.indexOf(key);
    return at === -1 ? sectionOrder.length : at;
  };
  const marked = bots
    .filter((bot) => bot.chiefOfStaff)
    .sort((a, b) => Number(Boolean(a.hidden)) - Number(Boolean(b.hidden)) || sidebarRank(a) - sidebarRank(b));
  const oldestFirst = [...bots].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return marked[0]?.id ?? oldestFirst.find((bot) => !bot.hidden)?.id ?? oldestFirst[0]?.id ?? null;
}
