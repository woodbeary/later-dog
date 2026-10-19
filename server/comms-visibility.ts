
import { sectionKey, type BotRecord, type GroupRecord, type Store } from "./store.ts";

export function getOrCreateChannel(
  store: Store,
  from: BotRecord,
  target: BotRecord,
  originatingGroup?: GroupRecord,
): GroupRecord {
  if (
    originatingGroup &&
    !originatingGroup.dm &&
    originatingGroup.memberIds.includes(from.id) &&
    originatingGroup.memberIds.includes(target.id)
  ) {
    return originatingGroup;
  }
  const existing = store.dmGroup(from.id, target.id);
  if (existing) {
    if (sectionKey(existing.section) !== sectionKey(from.section)) {
      return store.patchGroup(existing.id, { section: from.section }) ?? existing;
    }
    return existing;
  }
  return store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true, from.section);
}
