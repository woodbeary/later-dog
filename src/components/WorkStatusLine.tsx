import type { Bot, Message } from "@/state/store";
import { workLine } from "@/lib/work-state";
import { waitingOnStatus } from "@/lib/waiting-on";
import { openQuestion } from "@/lib/open-question";
import { t } from "@/lib/i18n";
import { pendingApprovals } from "./PendingApproval";
import { approvalAction } from "./ApprovalCard";

export function needsYouWords(name: string, messages: readonly Message[]): string | undefined {
  if (openQuestion(messages)) return t("question.card.named", { name });
  const open = pendingApprovals([...messages]).at(-1)?.message.card;
  return open ? t("approval.card.namedWantsTo", { name, action: approvalAction(open) }) : undefined;
}

export function WorkStatusLine({ bot, what }: { bot: Pick<Bot, "work" | "busy" | "waitingForTeammates" | "waitingOn">; what?: string }) {
  const work = what && bot.work?.kind === "needs-you" ? { ...bot.work, what } : bot.work;
  const line = workLine(work) ?? (!bot.busy && bot.waitingForTeammates ? waitingOnStatus(bot.waitingOn) : null);
  if (!line) return null;
  return <span data-work-state={bot.work?.kind ?? ""} className="truncate text-[12px] text-ink-secondary" role="status" title={line}>{line}</span>;
}
