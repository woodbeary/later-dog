import { useMemo, useState } from "react";
import { Check, MessageCircleQuestion, X } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  formatQuestionAnswers,
  MAX_CUSTOM_ANSWER,
  QUESTION_DISMISS_MESSAGE,
  type AskQuestion,
} from "../../shared/ask-question";
import { ExpandableText } from "./ExpandableText";
import { FoldedCard } from "./FoldedCard";
import { answerSummary, settledAnswer } from "@/lib/settled-answer";

interface Draft {
  picked: string[];
  custom: string;
  other: boolean;
}

const EMPTY: Draft = { picked: [], custom: "", other: false };

function answersOf(draft: Draft): string[] {
  const custom = draft.other ? draft.custom.trim() : "";
  return custom ? [...draft.picked, custom] : draft.picked;
}

function tabLabel(question: AskQuestion, index: number): string {
  return question.header ?? t("question.tab.numbered", { index: index + 1 });
}

export function QuestionCard({
  threadId,
  bot,
  message,
}: {
  threadId: string;
  bot?: Pick<Bot, "name">;
  message: Message;
}) {
  const { dispatch } = useStore();
  const card = message.card;
  const questions = card?.questionRequest?.questions ?? [];
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [active, setActive] = useState(0);
  const [sent, setSent] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [answeredAtMount] = useState(() => Boolean(card?.answered));

  const answered = useMemo(
    () => questions.map((_, index) => answersOf(drafts[index] ?? EMPTY).length > 0),
    [questions, drafts],
  );

  if (!card || !questions.length || card.dismissed || closing) return null;
  const settled = Boolean(card.answered) || sent !== null;
  const current = questions[Math.min(active, questions.length - 1)]!;
  const currentIndex = Math.min(active, questions.length - 1);
  const draft = drafts[currentIndex] ?? EMPTY;
  const answeredCount = answered.filter(Boolean).length;
  const complete = answeredCount === questions.length;
  const answerText = card.answeredText ?? sent;
  const shownAnswer = settled && answerText ? settledAnswer(answerText, questions) : "";
  const listsQuestions = questions.length > 1 && shownAnswer.startsWith("Q: ");

  const update = (index: number, next: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [index]: { ...(previous[index] ?? EMPTY), ...next } }));

  const choose = (label: string) => {
    if (settled) return;
    if (current.multiSelect) {
      const picked = draft.picked.includes(label)
        ? draft.picked.filter((entry) => entry !== label)
        : [...draft.picked, label];
      update(currentIndex, { picked });
      return;
    }
    update(currentIndex, { picked: [label], other: false });
    if (questions.length === 1) {
      send([[label]]);
      return;
    }
    const next = questions.findIndex((_, index) => index !== currentIndex && !answered[index]);
    if (next >= 0) setActive(next);
  };

  const toggleOther = () => {
    if (settled) return;
    if (draft.other) {
      update(currentIndex, { other: false });
      return;
    }
    update(currentIndex, { other: true, ...(current.multiSelect ? {} : { picked: [] }) });
  };

  const submit = () => {
    if (!complete) return;
    send(questions.map((_, index) => answersOf(drafts[index] ?? EMPTY)));
  };

  const send = (answers: string[][]) => {
    if (settled || !card.requestId) return;
    const answer = formatQuestionAnswers(questions, answers);
    if (!answer) return;
    setSent(answer);
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: card.requestId,
      behavior: "answer",
      message: answer,
      onError: () => setSent(null),
    });
  };

  const close = () => {
    if (settled || !card.requestId) return;
    setClosing(true);
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: card.requestId,
      behavior: "answer",
      message: QUESTION_DISMISS_MESSAGE,
      onError: () => setClosing(false),
    });
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea')?.focus());
  };

  const body = (
    <div
      role="group"
      aria-label={t("question.aria.card")}
      className={cn(
        "w-full max-w-[420px] rounded-[18px] bg-card px-3.5 py-3",
        settled ? "opacity-70" : "ring-[0.5px] ring-ink/10",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[14px] font-medium text-ink">
          {bot ? t("question.card.named", { name: bot.name }) : t("question.card.title")}
        </div>
        {!settled && (
          <div className="-my-1 -mr-1 flex shrink-0 items-center gap-2">
            {questions.length > 1 && (
              <span className="text-[11px] tabular-nums text-ink-secondary">
                {t("question.progress", { answered: answeredCount, count: questions.length })}
              </span>
            )}
            {card.requestId && (
              <button
                type="button"
                onClick={close}
                aria-label={t("question.close")}
                title={t("question.close")}
                data-question-close
                className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
      </div>

      {card.questionRequest?.origin === "output" && (
        <div className="mt-1 text-[12px] text-ink-secondary">{t("question.origin.badge")}</div>
      )}

      {questions.length > 1 && !listsQuestions && (
        <div role="tablist" aria-label={t("question.aria.tabs")} className="mt-3 flex flex-wrap gap-1">
          {questions.map((question, index) => (
            <button
              key={`${index}-${question.question}`}
              role="tab"
              aria-selected={index === currentIndex}
              onClick={() => setActive(index)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] transition-colors",
                index === currentIndex
                  ? "bg-control text-ink"
                  : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {answered[index] && <Check size={12} className="text-success" />}
              {tabLabel(question, index)}
            </button>
          ))}
        </div>
      )}

      {!listsQuestions && <ExpandableText text={current.question} className="mt-1.5 text-[14px] leading-[21px] text-ink" />}
      {current.multiSelect && !settled && (
        <div className="mt-1 text-[12.5px] text-ink-secondary">{t("question.multiHint")}</div>
      )}

      {!settled && (
        <div
          role={current.multiSelect ? "group" : "radiogroup"}
          aria-label={current.question}
          className="mt-2.5 overflow-hidden rounded-xl border border-hairline/40"
        >
          {current.options.map((option, index) => {
            const picked = draft.picked.includes(option.label);
            return (
              <button
                key={option.label}
                role={current.multiSelect ? "checkbox" : "radio"}
                aria-checked={picked}
                onClick={() => choose(option.label)}
                title={option.description}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left",
                  index > 0 && "border-t border-hairline/40",
                  picked ? "bg-raised-hover" : "hover:bg-raised-hover/60",
                )}
              >
                <Marker checked={picked} multi={Boolean(current.multiSelect)} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{option.label}</span>
              </button>
            );
          })}
          <button
            role={current.multiSelect ? "checkbox" : "radio"}
            aria-checked={draft.other}
            onClick={toggleOther}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-2 text-left",
              current.options.length > 0 && "border-t border-hairline/40",
              draft.other ? "bg-raised-hover" : "hover:bg-raised-hover/60",
            )}
          >
            <Marker checked={draft.other} multi={Boolean(current.multiSelect)} />
            <span className="text-[14px] text-ink">{t("question.other")}</span>
          </button>
          {draft.other && (
            <div className="border-t border-hairline/40 px-3 py-2.5">
              <input
                autoFocus
                value={draft.custom}
                maxLength={MAX_CUSTOM_ANSWER}
                onChange={(event) => update(currentIndex, { custom: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && complete) submit();
                }}
                placeholder={t("question.otherPlaceholder")}
                className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </div>
          )}
        </div>
      )}

      {settled ? (
        <div className="mt-3 flex items-start gap-1.5 text-[13px] text-ink-secondary">
          <Check size={14} className="mt-0.5 shrink-0 text-success" />
          <span className="whitespace-pre-wrap break-words">{shownAnswer || t("question.status.answered")}</span>
        </div>
      ) : (questions.length > 1 || current.multiSelect || draft.other) && (
        <div className="mt-3 flex items-center justify-end gap-3">
          <span className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
            <MessageCircleQuestion size={14} className="text-accent" />
            {t("question.status.waiting")}
          </span>
          <button
            onClick={submit}
            disabled={!complete}
            className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {questions.length > 1 ? t("question.submitAll") : t("question.submit")}
          </button>
        </div>
      )}
    </div>
  );
  if (!settled) return body;
  const line = answerText ? answerSummary(answerText, questions) : t("question.status.answered");
  return (
    <FoldedCard
      icon={<Check size={14} className="shrink-0 text-success" />}
      summary={<span className="min-w-0 truncate">{line}</span>}
      title={line}
      label={t("question.answered.label", { answer: line })}
      arriving={!answeredAtMount}
      takeFocus={sent !== null}
    >
      {body}
    </FoldedCard>
  );
}

function Marker({ checked, multi }: { checked: boolean; multi: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
        multi ? "rounded-[5px]" : "rounded-full",
        checked ? "border-accent bg-accent" : "border-hairline",
      )}
    >
      {checked &&
        (multi ? (
          <Check size={11} className="text-white" strokeWidth={3} />
        ) : (
          <span className="size-1.5 rounded-full bg-white" />
        ))}
    </span>
  );
}
