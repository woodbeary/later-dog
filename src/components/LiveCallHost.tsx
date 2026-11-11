import { useEffect } from "react";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { handleLiveCallKey, onLiveStreamConnected, onServerCall } from "@/lib/live-call-media";
import { useStoreSelector } from "@/state/store-selectors";

export function LiveCallHost() {
  const liveCall = useStoreSelector((state) => state.liveCall);
  const connected = useStoreSelector((state) => state.connected);
  useEffect(() => onServerCall(liveCall), [liveCall]);
  useEffect(() => onLiveStreamConnected(connected), [connected]);
  useEffect(() => {
    const isMac = isMacPlatform();
    const onKey = (event: KeyboardEvent) => {
      if (handleLiveCallKey(event, isMac)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
