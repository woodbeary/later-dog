import { useState } from "react";
import { Check, X } from "lucide-react";
import { useStore, visibleMessages, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isPersistentQuestionCard, parseChoices } from "../../shared/ask-question";
import { ExpandableText } from "./ExpandableText";
import { FoldedCard } from "./FoldedCard";
import { optionCardTitle } from "@/lib/option-card-title";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const DECISIONS = new Set(["answer", "allow", "deny"]);

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
  if (card.requestId && isPersistentQuestionCard(card)) return !card.dismissed;
  return true;
}

function chosenAnswer(card: NonNullable<Message["card"]>, picked?: string): string | undefined {
  if (card.answeredText) return card.answeredText;
  if (card.answered && !DECISIONS.has(card.answered)) return card.answered;
  return picked;
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
  const [picked, setPicked] = useState<string>();
  const [answeredAtMount] = useState(() => Boolean(message.card?.answered));
  const card = message.card;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const transcript = bot ? visibleMessages(bot) : [];
  if (!card || shouldHideOnboardingCard(message, transcript) || (card.requestId && card.dismissed && card.answered)) return null;

  const title = optionCardTitle(card, bot?.name);
  const subtitle = card.subtitle;
  const options = parseChoices(card.options, LETTERS.length) ?? [];
  const answered = Boolean(card.answered) || picked !== undefined;
  const chosen = answered ? chosenAnswer(card, picked) : undefined;

  const answer = (text: string) => {
    if (!text.trim()) return;
    if (answered) return;
    if (card.requestId && !card.tool && (threadId || bot?.threadId)) {
      setPicked(text.trim());
      dispatch({
        type: "decideRequest",
        threadId: threadId ?? bot!.threadId,
        requestId: card.requestId,
        behavior: "answer",
        message: text.trim(),
        onError: () => setPicked(undefined),
      });
      return;
    }
    dispatch({ type: "answerCard", botId, threadId, messageId: message.id, answer: text.trim(), groupId });
  };

  const body = (
    <div
      className={cn(
        "w-full max-w-[420px] rounded-question bg-card px-4 py-3.5",
        answered ? "opacity-70" : "shadow-elevated",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-ink">{title}</div>
          {subtitle && (
            <ExpandableText text={subtitle} className="mt-0.5 text-[13px] text-ink-secondary" />
          )}
        </div>
        {!answered && canDismissOptionCard(card) && (
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
            disabled={answered}
            onClick={() => answer(opt)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] text-ink",
              i > 0 && "border-t border-hairline/40",
              chosen === opt
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

      {answered && chosen && !options.includes(chosen) && (
        <div className="mt-2.5 flex items-start gap-1.5 text-[13px] text-ink-secondary">
          <Check size={14} className="mt-0.5 shrink-0 text-success" />
          <span className="whitespace-pre-wrap break-words">{chosen}</span>
        </div>
      )}

      {!answered && !card.tool && (
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

  if (!answered) return body;
  const line = chosen ?? t("question.status.answered");
  return (
    <FoldedCard
      icon={<Check size={14} className="shrink-0 text-success" />}
      summary={<span className="min-w-0 truncate">{line}</span>}
      title={line}
      label={t("question.answered.label", { answer: line })}
      arriving={!answeredAtMount}
      takeFocus={picked !== undefined}
    >
      {body}
    </FoldedCard>
  );
}
