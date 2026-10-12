import { useState } from "react";
import { X } from "lucide-react";
import { useStore, visibleMessages, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isPersistentQuestionCard, parseChoices } from "../../shared/ask-question";
import { ExpandableText } from "./ExpandableText";
import { optionCardTitle } from "@/lib/option-card-title";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function isOnboardingCard(message: Message): boolean {
  return message.kind === "options" && !!message.card && !message.card.requestId;
}

export function shouldHideOnboardingCard(message: Message, transcript: Message[]): boolean {
  if (!isOnboardingCard(message) || !message.card) return false;
  if (message.card.dismissed || message.card.answered) return true;
  const index = transcript.findIndex((entry) => entry.id === message.id);
  if (index < 0) return false;
  return transcript.slice(index + 1).some((later) => later.role === "user" && later.kind === "text");
}

export function canDismissOptionCard(card: NonNullable<Message["card"]>): boolean {
  if (card.requestId && isPersistentQuestionCard(card)) return card.answered === "answer" && !card.dismissed;
  return true;
}

export function OptionCard({
  botId,
  threadId,
  message,
  groupId,
}: {
  botId: string;
  threadId?: string;
  message: Message;
  groupId?: string;
}) {
  const { state, dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const transcript = bot ? visibleMessages(bot) : [];
  if (!card || shouldHideOnboardingCard(message, transcript) || (card.requestId && card.dismissed && card.answered)) return null;

  const title = optionCardTitle(card, bot?.name);
  const subtitle = card.subtitle;
  const options = parseChoices(card.options, LETTERS.length) ?? [];

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, threadId, messageId: message.id, answer: text.trim(), groupId });
  };

  return (
    <div className="w-full max-w-[420px] rounded-[18px] bg-card px-3.5 py-3 ring-[0.5px] ring-ink/10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-ink">{title}</div>
          {subtitle && (
            <ExpandableText text={subtitle} className="mt-0.5 text-[13px] text-ink-secondary" />
          )}
        </div>
        {canDismissOptionCard(card) && (
          <button
            onClick={() =>
              dispatch({ type: "dismissCard", botId, threadId, messageId: message.id, groupId })
            }
            className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label={t("onboarding.card.dismiss")}
            title={t("onboarding.card.dismiss")}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="mt-2.5 overflow-hidden rounded-xl border border-hairline/40">
        {options.map((opt, i) => (
          <button
            key={opt}
            disabled={!!card.answered}
            onClick={() => answer(opt)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] text-ink",
              i > 0 && "border-t border-hairline/40",
              (card.answeredText ?? card.answered) === opt
                ? "bg-raised-hover"
                : "hover:bg-raised-hover/60 disabled:hover:bg-transparent",
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-control text-[11px] font-medium text-ink-secondary">
              {LETTERS[i]}
            </span>
            {opt}
          </button>
        ))}
      </div>

      {!card.answered && !card.tool && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && answer(custom)}
          placeholder={t("onboarding.card.custom")}
          className="mt-2 h-8 w-full rounded-full border-[0.5px] border-ink/15 bg-composer px-3 text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
        />
      )}
    </div>
  );
}
