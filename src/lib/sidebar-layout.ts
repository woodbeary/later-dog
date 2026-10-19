import type { ConnectorCardData } from "../../shared/wire";

export const UNASSIGNED_SECTION_ID = "builtin:bots";
export const HIDDEN_SECTION_ID = "builtin:hidden";

const USER_SECTION_PREFIX = "section:";

export type SidebarSectionId = string;
export type SectionDropPlace = "before" | "after";
export type SidebarDensityMode = "comfortable" | "icons";

export type SidebarBot = {
  id: string;
  chiefOfStaff?: boolean;
  section?: string;
  pinned?: boolean;
  hidden?: boolean;
};

export type SidebarGroup = {
  id: string;
  section?: string;
  dm?: boolean;
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function userSectionId(name: string): SidebarSectionId {
  return `${USER_SECTION_PREFIX}${name}`;
}

export function userSectionName(id: SidebarSectionId): string | null {
  if (!id.startsWith(USER_SECTION_PREFIX)) return null;
  return id.slice(USER_SECTION_PREFIX.length);
}

export type SidebarConnectorPreviewKey = "connectors.card.connected" | "connectors.card.waiting" | "connectors.card.connectSecurely";

export function sidebarConnectorPreview(
  connector: Pick<ConnectorCardData, "label" | "status" | "dismissed">,
  say: (key: SidebarConnectorPreviewKey) => string,
): string {
  if (connector.dismissed) return connector.label;
  const key: SidebarConnectorPreviewKey = connector.status === "connected"
    ? "connectors.card.connected"
    : connector.status === "authorizing" ? "connectors.card.waiting" : "connectors.card.connectSecurely";
  return `${connector.label} · ${say(key)}`;
}

export function sidebarLayoutInteractive(density: SidebarDensityMode): boolean {
  return density !== "icons";
}

export function sidebarSectionCollapsed(
  id: SidebarSectionId,
  collapsedIds: SidebarSectionId[],
  density: SidebarDensityMode,
): boolean {
  return sidebarLayoutInteractive(density) && collapsedIds.includes(id);
}

export function partitionSidebarBots<T extends SidebarBot>(bots: T[]) {
  const visible = bots.filter((bot) => !bot.hidden);
  const pinnedBots = visible
    .filter((bot) => Boolean(bot.pinned))
    .sort((a, b) => Number(Boolean(b.chiefOfStaff)) - Number(Boolean(a.chiefOfStaff)));
  const sectionedBots = visible.filter((bot) => !bot.pinned && Boolean(bot.section));
  const unsectionedBots = visible.filter((bot) => !bot.pinned && !bot.section);
  const hiddenBots = bots.filter((bot) => bot.hidden);
  return { pinnedBots, sectionedBots, unsectionedBots, hiddenBots };
}

export function partitionSidebarGroups<T extends SidebarGroup>(groups: T[]) {
  const rooms = groups.filter((group) => !group.dm);
  const sectionedRooms = rooms.filter((group) => Boolean(group.section));
  const unsectionedRooms = rooms.filter((group) => !group.section);
  return { sectionedRooms, unsectionedRooms };
}

export function orderPinnedBots<T extends SidebarBot>(pinned: T[], savedOrder: readonly string[]): T[] {
  const rank = (bot: T) => {
    const index = savedOrder.indexOf(bot.id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return pinned
    .map((bot, index) => ({ bot, index }))
    .sort((a, b) => Number(Boolean(b.bot.chiefOfStaff)) - Number(Boolean(a.bot.chiefOfStaff)) || rank(a.bot) - rank(b.bot) || a.index - b.index)
    .map(({ bot }) => bot);
}

export function sidebarSectionNames(saved: readonly string[], records: ReadonlyArray<{ section?: string }>): string[] {
  const names = unique([...saved]);
  for (const record of records) if (record.section && !names.includes(record.section)) names.push(record.section);
  return names;
}

export function moveSection(
  ids: SidebarSectionId[],
  id: SidebarSectionId,
  direction: -1 | 1,
): SidebarSectionId[] {
  const index = ids.indexOf(id);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= ids.length) return ids;
  const result = [...ids];
  const [moved] = result.splice(index, 1);
  result.splice(destination, 0, moved!);
  return result;
}

export function placeSection(
  ids: SidebarSectionId[],
  fromId: SidebarSectionId,
  targetId: SidebarSectionId,
  place: SectionDropPlace,
): SidebarSectionId[] {
  if (fromId === targetId || !ids.includes(fromId) || !ids.includes(targetId)) return ids;
  const result = ids.filter((id) => id !== fromId);
  let destination = result.indexOf(targetId);
  if (place === "after") destination += 1;
  result.splice(destination, 0, fromId);
  return result;
}
