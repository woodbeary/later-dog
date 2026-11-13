import type { Bot, Message } from "@/state/store";
import { workLine } from "@/lib/work-state";
import { waitingOnStatus } from "@/lib/waiting-on";
import { openQuestion } from "@/lib/open-question";
import { t } from "@/lib/i18n";
import { pendingApprovals } from "./PendingApproval";
import { approvalAction } from "./ApprovalCard";

export type OpenAsk =
  | { kind: "proxy"; name: string; label: string }
  | { kind: "question" }
  | { kind: "approval"; action: string };

export function newestAsk(messages: readonly Message[]): OpenAsk | undefined {
  const question = openQuestion([...messages].reverse())?.message;
  const approval = pendingApprovals([...messages]).at(-1)?.message;
  const proxy = messages.findLast((message) => message.needsYou?.status === "waiting");
  const newest = [proxy, question, approval].filter((message): message is Message => Boolean(message))
    .sort((left, right) => messages.indexOf(right) - messages.indexOf(left))[0];
  if (!newest) return undefined;
  if (newest === proxy) return { kind: "proxy", name: proxy.needsYou!.botName, label: proxy.needsYou!.label };
  if (newest === question) return { kind: "question" };
  return { kind: "approval", action: approvalAction(approval!.card!) };
}

export function needsYouWords(name: string, messages: readonly Message[]): string | undefined {
  const ask = newestAsk(messages);
  if (!ask) return undefined;
  if (ask.kind === "proxy") return t("chat.needsYou.proxy", { name: ask.name, label: ask.label });
  return ask.kind === "question" ? t("question.card.named", { name }) : t("approval.card.namedWantsTo", { name, action: ask.action });
}

export function WorkStatusLine({ bot, what }: { bot: Pick<Bot, "work" | "busy" | "waitingForTeammates" | "waitingOn">; what?: string }) {
  const work = what && bot.work?.kind === "needs-you" ? { ...bot.work, what } : bot.work;
  const line = workLine(work) ?? (!bot.busy && bot.waitingForTeammates ? waitingOnStatus(bot.waitingOn) : null);
  if (!line) return null;
  return <span data-work-state={bot.work?.kind ?? ""} className="truncate text-[12px] text-ink-secondary" role="status" title={line}>{line}</span>;
}
