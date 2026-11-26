import type { RoomHandoff } from "../room-handoffs.ts";

interface TeammateContextHooks {
  allowed(node: RoomHandoff): boolean;
  stored(id: string): boolean;
  append(node: RoomHandoff): void;
  acknowledge(ids: readonly string[]): void;
}

export function saveTeammateContext(nodes: readonly RoomHandoff[], hooks: TeammateContextHooks): boolean {
  let appended = false;
  for (const node of nodes) {
    if (!hooks.allowed(node) || hooks.stored(node.id)) continue;
    hooks.append(node);
    appended = true;
  }
  hooks.acknowledge(nodes.map(node => node.id));
  return appended;
}
