import { useEffect } from "react";
import { unreadChats } from "@/state/shell-view";
import { useStoreSelector } from "@/state/store-selectors";

export function UnreadCountBadge() {
  const unreadCount = useStoreSelector(unreadChats);
  useEffect(() => {
    window.laterdog?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);
  return null;
}
