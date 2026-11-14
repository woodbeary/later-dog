import type { Bot } from "@/state/store";
import { workLine } from "@/lib/work-state";
import { waitingOnStatus } from "@/lib/waiting-on";
import { WorkingTimer } from "./WorkingIndicator";

export function WorkStatusLine({ bot }: { bot: Pick<Bot, "work" | "busy" | "waitingForTeammates" | "waitingOn"> }) {
  const line = workLine(bot.work) ?? (!bot.busy && bot.waitingForTeammates ? waitingOnStatus(bot.waitingOn) : null);
  if (!line) return null;
  const since = bot.work?.kind === "running" && !bot.busy ? bot.work.computerSince : undefined;
  return <span data-work-state={bot.work?.kind ?? ""} className="truncate text-[12px] text-ink-secondary" role="status">{line}{since !== undefined && <>{" · "}<WorkingTimer since={since} /></>}</span>;
}
