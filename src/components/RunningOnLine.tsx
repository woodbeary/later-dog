import { useMemo } from "react";
import type { Message } from "@/state/store";
import { useStoreSelector } from "@/state/store-selectors";
import { standingNotice } from "@/lib/standing-notice";
import { StatusActivityRow } from "./StatusActivityRow";

export function runningOnNotice(messages: readonly Message[], on: string | undefined): Message | null {
  if (!on) return null;
  const notice = messages.findLast(standingNotice);
  return notice?.tool?.carry?.to === on ? notice : null;
}

export function RunningOnLine({ messages, threadId }: { messages: readonly Message[]; threadId: string }) {
  const on = useStoreSelector((state) => state.config?.accountBattery?.routed?.[threadId]?.on);
  const notice = useMemo(() => runningOnNotice(messages, on), [messages, on]);
  if (!notice) return null;
  return (
    <div data-running-on className="pointer-events-auto mx-5 mb-1.5 flex justify-end">
      <StatusActivityRow message={notice} />
    </div>
  );
}
