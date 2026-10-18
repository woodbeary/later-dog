import { BOTS_SECTION_ID, userSectionName, type SidebarSectionId } from "./sidebar-layout";

export const DOG_DRAG_TYPE = "application/x-laterdog-dog";

export function sectionForDogDrop(id: SidebarSectionId): string | null {
  if (id === BOTS_SECTION_ID) return "";
  return userSectionName(id);
}

export function dogDropChangesSection(current: string | undefined, target: string | null): target is string {
  return target !== null && (current?.trim() ?? "") !== target;
}
