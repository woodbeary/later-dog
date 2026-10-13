import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

export const ACCOUNT_DRAG_TYPE = "application/x-laterdog-account";

export interface DragAccount {
  id: string;
  kind: string;
  movable: boolean;
}

export function movedTo(order: readonly string[], id: string, to: number): string[] {
  const next = order.filter((other) => other !== id);
  next.splice(to, 0, id);
  return next;
}

export type AccountDrag = ReturnType<typeof useAccountDrag>;

export function useAccountDrag(items: readonly DragAccount[], onReorder: (ids: string[]) => void) {
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const regain = useRef<{ element: HTMLElement; from: string } | null>(null);
  const ids = items.map((item) => item.id);
  const key = ids.join("\n");
  const kindOf = (id: string | undefined) => items.find((item) => item.id === id)?.kind;
  const movable = (id: string) => items.some((item) => item.id === id && item.movable);
  useLayoutEffect(() => {
    const pending = regain.current;
    if (!pending || pending.from === key) return;
    regain.current = null;
    const active = document.activeElement;
    if (pending.element.isConnected && (!active || active === document.body)) pending.element.focus();
  });
  const step = (event: KeyboardEvent<HTMLElement>, id: string, withoutAlt = false) => {
    if ((!event.altKey && !withoutAlt) || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || !movable(id)) return;
    event.preventDefault();
    const to = ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || kindOf(ids[to]) !== kindOf(id)) return;
    regain.current = { element: event.currentTarget, from: key };
    onReorder(movedTo(ids, id, to));
  };
  const drop = () => {
    if (drag && drag.order.join("\n") !== ids.join("\n")) onReorder(drag.order);
    setDrag(null);
  };
  const list = {
    onDragOver: (event: DragEvent) => {
      if (!drag) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: DragEvent) => {
      if (!drag) return;
      event.preventDefault();
      drop();
    },
  };
  const row = (id: string) => ({
    draggable: movable(id) || undefined,
    onDragStart: (event: DragEvent) => {
      if (!movable(id) || event.target !== event.currentTarget) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(ACCOUNT_DRAG_TYPE, id);
      setDrag({ id, order: ids });
    },
    onDragOver: () => {
      const at = drag ? drag.order.indexOf(id) : -1;
      if (!drag || drag.id === id || at < 0 || kindOf(drag.id) !== kindOf(id)) return;
      setDrag({ id: drag.id, order: movedTo(drag.order, drag.id, at) });
    },
    onDragEnd: () => setDrag(null),
  });
  return { order: drag?.order ?? ids, dragging: drag?.id, list, row, step, movable };
}
