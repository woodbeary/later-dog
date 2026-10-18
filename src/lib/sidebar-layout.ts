import type { ConnectorCardData } from "../../shared/wire";

export const PINNED_SECTION_ID = "builtin:pinned";
export const CHANNELS_SECTION_ID = "builtin:channels";
export const BOTS_SECTION_ID = "builtin:bots";

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

export function sidebarSectionLabel(id: SidebarSectionId): string {
  if (id === PINNED_SECTION_ID) return "Pinned";
  if (id === CHANNELS_SECTION_ID) return "Group chats";
  if (id === BOTS_SECTION_ID) return "Dogs";
  return userSectionName(id) ?? id;
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

export function sidebarLayoutInteractive(density: SidebarDensityMode, query: string): boolean {
  return density !== "icons" && query.trim().length === 0;
}

export function sidebarSectionCollapsed(
  id: SidebarSectionId,
  collapsedIds: SidebarSectionId[],
  density: SidebarDensityMode,
  query: string,
): boolean {
  return sidebarLayoutInteractive(density, query) && collapsedIds.includes(id);
}

export function partitionSidebarBots<T extends SidebarBot>(bots: T[]) {
  const visible = bots.filter((bot) => !bot.hidden);
  const pinnedBots = visible
    .filter((bot) => Boolean(bot.pinned))
    .sort((a, b) => Number(Boolean(b.chiefOfStaff)) - Number(Boolean(a.chiefOfStaff)));
  const sectionedBots = visible.filter((bot) => !bot.pinned && Boolean(bot.section));
  const unsectionedBots = visible.filter((bot) => !bot.pinned && !bot.section);
  return { pinnedBots, sectionedBots, unsectionedBots };
}

export function partitionSidebarGroups<T extends SidebarGroup>(groups: T[]) {
  const rooms = groups.filter((group) => !group.dm);
  const sectionedRooms = rooms.filter((group) => Boolean(group.section));
  const unsectionedRooms = rooms.filter((group) => !group.section);
  return { sectionedRooms, unsectionedRooms };
}

export function orderedSidebarSections(
  present: SidebarSectionId[],
  savedOrder: SidebarSectionId[],
): SidebarSectionId[] {
  const visible = unique(present);
  const visibleSet = new Set(visible);
  const result = unique(savedOrder).filter((id) => visibleSet.has(id));
  if (result.length === 0) return visible;

  for (const id of visible) {
    if (result.includes(id)) continue;
    const naturalIndex = visible.indexOf(id);
    const naturalPredecessors = visible.slice(0, naturalIndex).reverse();
    const naturalSuccessors = visible.slice(naturalIndex + 1);
    const predecessor = naturalPredecessors.find((candidate) => result.includes(candidate));
    const successor = naturalSuccessors.find((candidate) => result.includes(candidate));
    const predecessorIndex = predecessor ? result.indexOf(predecessor) : -1;
    const successorIndex = successor ? result.indexOf(successor) : -1;

    if (predecessorIndex >= 0 && (successorIndex < 0 || predecessorIndex < successorIndex)) {
      result.splice(predecessorIndex + 1, 0, id);
    } else if (successorIndex >= 0) {
      result.splice(successorIndex, 0, id);
    } else {
      result.push(id);
    }
  }
  return result;
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

export function mergeSectionOrder(
  savedOrder: SidebarSectionId[],
  visibleOrder: SidebarSectionId[],
): SidebarSectionId[] {
  const saved = unique(savedOrder);
  const result = unique(visibleOrder);
  const included = new Set(result);

  for (let savedIndex = 0; savedIndex < saved.length; savedIndex += 1) {
    const id = saved[savedIndex]!;
    if (included.has(id)) continue;
    let destination = result.length;
    let foundPredecessor = false;
    for (let previous = savedIndex - 1; previous >= 0; previous -= 1) {
      const previousPosition = result.indexOf(saved[previous]!);
      if (previousPosition >= 0) {
        destination = previousPosition + 1;
        foundPredecessor = true;
        break;
      }
    }
    if (!foundPredecessor) {
      for (let next = savedIndex + 1; next < saved.length; next += 1) {
        const nextPosition = result.indexOf(saved[next]!);
        if (nextPosition >= 0) {
          destination = nextPosition;
          break;
        }
      }
    }
    result.splice(destination, 0, id);
    included.add(id);
  }
  return result;
}

export function sameSectionOrder(a: SidebarSectionId[], b: SidebarSectionId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
