import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, Minus } from "lucide-react";
import type { Bot, Message } from "@/state/store";
import { useStoreDispatch } from "@/state/store-selectors";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  formatQuestionAnswers,
  MAX_CUSTOM_ANSWER,
  type AskQuestion,
} from "../../shared/ask-question";
import { ExpandableText } from "./ExpandableText";
import "../composer-parity.css";
import { FoldedCard } from "./FoldedCard";
import { answerSummary, settledAnswer } from "@/lib/settled-answer";
import { chooseTypedAnswer, releaseTypedAnswer, typedAnswerFor, useTypedAnswer, type Composed } from "@/lib/typed-answer";

interface Draft {
  picked: string[];
  other: boolean;
  typed: string;
}

const EMPTY: Draft = { picked: [], other: false, typed: "" };

export const QUESTION_PICK_HOLD_MS = 600;

function editable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || !(element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName))) return false;
  const emptyComposer = element instanceof HTMLTextAreaElement && element.closest('[data-tour="composer"]') !== null && element.value === "";
  return !emptyComposer;
}

function answersOf(draft: Draft): string[] {
  const typed = draft.other ? draft.typed.trim() : "";
  return typed ? [...draft.picked, typed] : draft.picked;
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
  const dispatch = useStoreDispatch();
  const card = message.card;
  const questions = card?.questionRequest?.questions ?? [];
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [active, setActive] = useState(0);
  const [sent, setSent] = useState<string | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const [answeredAtMount] = useState(() => Boolean(card?.answered));
  const [missing, setMissing] = useState<string | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const targetRef = useRef(0);
  const holdRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(holdRef.current), []);
  const settledNow = Boolean(card?.answered) || sent !== null || Boolean(card?.dismissed);
  useEffect(() => { if (settledNow) releaseTypedAnswer(message.id, true); }, [settledNow, message.id]);
  useEffect(() => () => releaseTypedAnswer(message.id), [message.id]);
  const typing = useTypedAnswer(threadId)?.messageId === message.id;
  useEffect(() => {
    if (typing) return;
    setMissing(null);
    setDrafts((previous) => {
      const waiting = Object.entries(previous).filter(([, entry]) => entry.other && !entry.typed.trim());
      if (!waiting.length) return previous;
      return { ...previous, ...Object.fromEntries(waiting.map(([index, entry]) => [index, { ...entry, other: false }])) };
    });
  }, [typing]);

  const answered = useMemo(
    () => questions.map((_, index) => answersOf(drafts[index] ?? EMPTY).length > 0),
    [questions, drafts],
  );

  if (!card || !questions.length || card.dismissed) return null;
  const settled = Boolean(card.answered) || sent !== null;
  const external = card.answered === "resolved";
  const current = questions[Math.min(active, questions.length - 1)]!;
  const currentIndex = Math.min(active, questions.length - 1);
  const draft = drafts[currentIndex] ?? EMPTY;
  const answeredCount = answered.filter(Boolean).length;
  const complete = answeredCount === questions.length;
  const lastStep = currentIndex === questions.length - 1;
  const stepAnswered = answered[currentIndex] === true || Boolean(draft.other);
  const answerText = card.answeredText ?? (external ? "Resolved externally" : sent);
  const shownAnswer = external ? answerText ?? "" : settled && answerText ? settledAnswer(answerText, questions) : "";
  const listsQuestions = questions.length > 1 && shownAnswer.startsWith("Q: ");

  const update = (index: number, next: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [index]: { ...(previous[index] ?? EMPTY), ...next } }));

  const choose = (label: string) => {
    if (settled || holding !== null) return;
    if (current.multiSelect) {
      const picked = draft.picked.includes(label)
        ? draft.picked.filter((entry) => entry !== label)
        : [...draft.picked, label];
      update(currentIndex, { picked });
      return;
    }
    update(currentIndex, { picked: [label], other: false });
    setMissing(null);
    if (questions.length === 1) {
      setHolding(label);
      window.clearTimeout(holdRef.current);
      holdRef.current = window.setTimeout(() => {
        setHolding(null);
        send([[label]]);
      }, QUESTION_PICK_HOLD_MS);
      return;
    }
    if (!lastStep) setActive(currentIndex + 1);
  };

  const step = (offset: number) => setActive(Math.max(0, Math.min(questions.length - 1, currentIndex + offset)));

  const compose = (text: string): Composed => {
    const target = targetRef.current;
    const held = { ...draftsRef.current, [target]: { ...(draftsRef.current[target] ?? EMPTY), other: true, typed: text } };
    draftsRef.current = held;
    setDrafts(held);
    const answers = questions.map((_, index) => answersOf(held[index] ?? EMPTY));
    const gap = answers.findIndex((picked) => !picked.length);
    if (gap < 0) {
      setMissing(null);
      const message = formatQuestionAnswers(questions, answers);
      return message ? { message } : null;
    }
    setActive(gap);
    if (held[gap]?.other) {
      targetRef.current = gap;
      setMissing(null);
    } else setMissing(tabLabel(questions[gap]!, gap));
    return { kept: true };
  };

  const holdsComposer = () => typedAnswerFor(threadId)?.messageId === message.id;

  const listen = (index: number) => {
    if (settled || !card.requestId) return;
    targetRef.current = index;
    chooseTypedAnswer({
      threadId,
      messageId: message.id,
      requestId: card.requestId,
      compose,
      limit: MAX_CUSTOM_ANSWER,
      sent: (answer) => setSent(answer),
      failed: () => setSent(null),
    });
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

  const body = (
    <QuestionKeys
      active={!settled && holding === null}
      holds={holdsComposer}
      count={Math.min(9, current.options.length)}
      pick={(index) => choose(current.options[index]!.label)}
      listen={() => listen(currentIndex)}
      listenKey={`${currentIndex}:${settled}`}
    >
    <div
      role="group"
      aria-label={t("question.aria.card")}
      data-question-card
      className={cn("question-parity w-full", settled && "opacity-70")}
    >
      {!listsQuestions && <ExpandableText text={current.question} className="question-parity-title" />}
      {card.nativeActorLabel && <p className="mt-1 text-[12px] text-ink-secondary">Requested by {card.nativeActorLabel}</p>}
      {card.questionRequest?.origin === "output" && (
        <div className="mt-1 text-[12px] text-ink-secondary">{t("question.origin.badge")}</div>
      )}
      {current.multiSelect && !settled && (
        <div className="mt-1 text-[13px] leading-[17px] text-ink-secondary">{t("question.multiHint")}</div>
      )}

      {!settled && (
        <div
          role={current.multiSelect ? "group" : "radiogroup"}
          aria-label={current.question}
          className="mt-2 flex flex-col"
        >
          {current.options.map((option, index) => {
            const picked = draft.picked.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                role={current.multiSelect ? "checkbox" : "radio"}
                aria-checked={picked}
                data-question-option={index + 1}
                onClick={() => choose(option.label)}
                className="question-parity-row"
              >
                <span aria-hidden="true" className="question-parity-number">{index + 1}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="question-parity-label">{option.label}</span>
                  {option.description && <span className="question-parity-description">{option.description}</span>}
                </span>
                {picked && <Check data-question-check size={16} strokeWidth={2.25} aria-hidden="true" className="question-parity-check" />}
              </button>
            );
          })}
          {draft.other && draft.typed && <p data-question-held className="question-parity-held">{draft.typed}</p>}
          {missing && (
            <p data-question-typing className="question-parity-held">{t("question.otherMissing", { name: missing })}</p>
          )}
        </div>
      )}

      {settled ? (
        <div className="mt-3 flex items-start gap-1.5 text-[13px] text-ink-secondary">
          {external ? <Minus size={14} className="mt-0.5 shrink-0" /> : <Check size={14} className="mt-0.5 shrink-0 text-success" />}
          <span className="whitespace-pre-wrap break-words">{shownAnswer || t("question.status.answered")}</span>
        </div>
      ) : questions.length > 1 ? (
        <div className="mt-2 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={currentIndex === 0}
            aria-label={t("question.back")}
            data-question-back
            className="flex items-center gap-0.5 rounded-full py-1 pl-1.5 pr-2.5 text-[13px] text-ink-secondary transition-colors hover:bg-control hover:text-ink disabled:invisible"
          >
            <ChevronLeft size={14} />
            {t("question.back")}
          </button>
          <span data-question-step className="text-[13px] tabular-nums text-ink-secondary">
            {t("question.step", { current: currentIndex + 1, count: questions.length })}
          </span>
          {lastStep ? (
            <button type="button" onClick={submit} disabled={!complete} data-question-submit className="question-parity-send">
              {t("question.send")}
            </button>
          ) : (
            <button type="button" onClick={() => step(1)} disabled={!stepAnswered} data-question-next className="question-parity-send">
              {t("question.next")}
            </button>
          )}
        </div>
      ) : (current.multiSelect || draft.other) && (
        <div className="mt-2 flex items-center justify-end">
          <button type="button" onClick={submit} disabled={!complete} data-question-submit className="question-parity-send">
            {t("question.send")}
          </button>
        </div>
      )}
    </div>
    </QuestionKeys>
  );
  if (!settled) return body;
  const line = external ? answerText! : answerText ? answerSummary(answerText, questions) : t("question.status.answered");
  return (
    <FoldedCard
      icon={external ? <Minus size={14} className="shrink-0" /> : <Check size={14} className="shrink-0 text-success" />}
      summary={<span className="min-w-0 truncate">{line}{external && card.nativeActorLabel && <span className="text-ink-tertiary"> · Requested by {card.nativeActorLabel}</span>}</span>}
      title={line}
      label={external ? line : t("question.answered.label", { answer: line })}
      arriving={!answeredAtMount}
      takeFocus={sent !== null}
    >
      {body}
    </FoldedCard>
  );
}

function QuestionKeys({ active, holds, count, pick, listen, listenKey, children }: {
  active: boolean;
  holds(): boolean;
  count: number;
  pick(index: number): void;
  listen(): void;
  listenKey: string;
  children: ReactNode;
}) {
  const latest = useRef({ active, holds, count, pick, listen });
  latest.current = { active, holds, count, pick, listen };
  useEffect(() => { latest.current.listen(); }, [listenKey]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const { active: on, holds: held, count: options, pick: choose } = latest.current;
      if (!on || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || editable(event.target) || !held()) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= options) return;
      event.preventDefault();
      choose(index);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  return <>{children}</>;
}
