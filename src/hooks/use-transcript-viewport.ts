import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type PointerEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow, useBottomFollowResize } from "@/lib/bottom-follow";
import { useFocusMessage } from "@/lib/focus-message";
import {
  TRANSCRIPT_WINDOW_SIZE,
  countedBefore,
  filledWindow,
  focusWindowRange,
  followWindowStart,
  openingWindow,
  resolveTranscriptWindow,
  stagedStart,
  widenedWindow,
  windowEndAfter,
  windowStartBefore,
  type CountsInWindow,
} from "@/lib/transcript-window";
import { useStore } from "@/state/store";

export function scrollBehavior(): ScrollBehavior {
  if (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true") return "auto";
  return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

export function endKeyScrolls(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented">, target: EventTarget | null): boolean {
  if (event.key !== "End" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return false;
  if (target instanceof HTMLTextAreaElement) return target.value.length === 0;
  return !(target instanceof HTMLElement && target.isContentEditable);
}

export const TYPING_PAUSE_MS = 300;

const LEAVE_BOTTOM_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

export function scrollKeyLeavesBottom(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented">,
  target: EventTarget | null,
  scroller: HTMLElement | null,
): boolean {
  if (!LEAVE_BOTTOM_KEYS.has(event.key) || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
  if (target === scroller.ownerDocument.body || target === scroller.ownerDocument.documentElement) return true;
  if (!(target instanceof Node) || !scroller.contains(target)) return false;
  const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || (target instanceof HTMLElement && target.isContentEditable);
  return !typing;
}

export function useTranscriptViewport<T extends { id: string; role?: string }>({
  ownerId,
  threadId,
  messages,
  pinOn,
  transcriptShown = true,
  counts,
  unread,
}: {
  ownerId: string;
  threadId: string;
  messages: readonly T[];
  pinOn: DependencyList;
  transcriptShown?: boolean;
  counts?: CountsInWindow<T>;
  unread?: (message: T) => boolean;
}) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const transcriptKey = `${ownerId}:${threadId}`;
  const tailStart = useMemo(() => windowStartBefore(messages, messages.length, TRANSCRIPT_WINDOW_SIZE, counts), [messages, counts]);
  const opening = useMemo(() => ({ ...openingWindow(transcriptKey, messages, counts, unread), ownerId }), [transcriptKey, messages, counts, unread, ownerId]);
  const [transcriptWindow, setTranscriptWindow] = useState(opening);
  const switched = transcriptWindow.key !== transcriptKey;
  const reopened = switched || (transcriptWindow.empty && messages.length > 0);
  const opensAtBottom = follow || transcriptWindow.ownerId !== ownerId;
  const reopening = opensAtBottom ? opening : filledWindow(opening, tailStart);
  const staged = reopened ? null : transcriptWindow.staged;
  const stagedAt = staged ? stagedStart(staged, messages) : -1;
  const stagingOver = staged !== null && (stagedAt <= tailStart || messages[0]?.id !== staged.oldestId);
  const nextStart = reopened
    ? reopening.start
    : !staged && follow && transcriptWindow.end === null
      ? followWindowStart(messages, transcriptWindow.start, counts)
      : transcriptWindow.start;
  if (reopened) {
    setTranscriptWindow(reopening);
  } else if (stagingOver) {
    setTranscriptWindow(filledWindow(transcriptWindow, stagedAt < 0 ? tailStart : Math.min(stagedAt, tailStart)));
  } else if (!staged && nextStart !== transcriptWindow.start) {
    setTranscriptWindow({ ...transcriptWindow, start: nextStart, end: null });
  }
  const windowStart = staged && !stagingOver ? stagedAt : transcriptWindow.start;
  const lastKeyAt = useRef(Number.NEGATIVE_INFINITY);
  const latest = useRef({ messages, counts });
  latest.current = { messages, counts };
  const {
    visible: windowedMessages,
    hiddenCount: hiddenBeforeShown,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(messages, windowStart, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end, counts),
    [messages, windowStart, transcriptWindow.end, counts],
  );
  const filledStart = staged ? Math.min(startIndex, tailStart) : startIndex;
  const filledMessages = useMemo(
    () => (staged ? messages.slice(filledStart) : windowedMessages),
    [staged, windowedMessages, messages, filledStart],
  );
  const hiddenCount = useMemo(
    () => (filledStart === startIndex ? hiddenBeforeShown : countedBefore(messages, filledStart, counts)),
    [filledStart, startIndex, hiddenBeforeShown, messages, counts],
  );

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);
  useBottomFollowResize(scrollRef, transcriptRef, followRef, transcriptShown ? transcriptKey : null);

  useEffect(() => setBottomFollow(true), [ownerId, setBottomFollow]);

  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end, staged: null, empty: false, ownerId });
  }, [threadId, messages, setBottomFollow, state.focusMessage, transcriptKey, ownerId]);
  useFocusMessage(threadId, messages.length > 0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinOn is the caller's dependency list
  }, [ownerId, messages.length, ...pinOn]);

  const preExpandHeight = useRef<{ key: string; height: number } | null>(null);
  const holdRowForPrepend = () => {
    preExpandHeight.current = scrollRef.current ? { key: transcriptKey, height: scrollRef.current.scrollHeight } : null;
    setBottomFollow(false);
  };
  const oldestId = messages[0]?.id;
  const stagedFirstId = transcriptWindow.staged?.firstId;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const captured = preExpandHeight.current;
    if (!captured || !el) return;
    preExpandHeight.current = null;
    if (captured.key !== transcriptKey) return;
    el.scrollTop += el.scrollHeight - captured.height;
    previousScrollTop.current = el.scrollTop;
  }, [transcriptWindow.start, stagedFirstId, oldestId, transcriptKey]);

  const waitingToFill = staged !== null && !stagingOver;
  useEffect(() => {
    if (!waitingToFill) return;
    let frame = 0;
    const widen = () => {
      if (performance.now() - lastKeyAt.current < TYPING_PAUSE_MS) {
        frame = requestAnimationFrame(widen);
        return;
      }
      const held = !followRef.current && scrollRef.current ? { key: transcriptKey, height: scrollRef.current.scrollHeight } : null;
      if (held) preExpandHeight.current = held;
      flushSync(() => {
        setTranscriptWindow((current) => (current.key === transcriptKey ? widenedWindow(current, latest.current.messages, latest.current.counts) : current));
      });
      if (preExpandHeight.current === held) preExpandHeight.current = null;
    };
    frame = requestAnimationFrame(widen);
    return () => cancelAnimationFrame(frame);
  }, [waitingToFill, transcriptKey, stagedFirstId]);

  const showEarlier = () => {
    holdRowForPrepend();
    const start = windowStartBefore(messages, filledStart, TRANSCRIPT_WINDOW_SIZE, counts);
    setTranscriptWindow((w) => filledWindow(w, start));
  };
  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = windowEndAfter(messages, endIndex, TRANSCRIPT_WINDOW_SIZE, counts);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= messages.length ? null : nextEnd }));
  };
  const olderPending = Boolean(state.loadingOlder[threadId]);
  const loadOlder = () => {
    holdRowForPrepend();
    dispatch({ type: "loadOlderMessages", threadId });
  };

  const jumpRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      lastKeyAt.current = performance.now();
      if (scrollKeyLeavesBottom(e, e.target, scrollRef.current)) setBottomFollow(false);
      if (endKeyScrolls(e, e.target) && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        e.preventDefault();
        jumpRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpToLatest = () => {
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: tailStart, end: null, staged: null, empty: false, ownerId });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: scrollBehavior() });
    });
  };
  jumpRef.current = jumpToLatest;
  const scrollToUnread = () => {
    const divider = scrollRef.current?.querySelector<HTMLElement>("[data-unread-divider]");
    if (!divider) return;
    setBottomFollow(false);
    divider.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  };

  const scrollHandlers = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      if (el && e.target === el && e.nativeEvent.offsetX >= el.clientWidth) setBottomFollow(false);
    },
    onWheel: (e: WheelEvent<HTMLDivElement>) => {
      if (e.deltaY < 0) setBottomFollow(false);
      else if (atEnd()) setBottomFollow(true);
    },
    onTouchStart: (e: TouchEvent<HTMLDivElement>) => {
      touchY.current = e.touches[0]?.clientY ?? 0;
    },
    onTouchMove: (e: TouchEvent<HTMLDivElement>) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY.current + 4) setBottomFollow(false);
      else if (atEnd()) setBottomFollow(true);
    },
    onScroll: () => {
      const el = scrollRef.current;
      if (!el) return;
      const scrollTop = el.scrollTop;
      const resume = shouldResumeBottomFollow({
        following: followRef.current,
        previousScrollTop: previousScrollTop.current,
        scrollTop,
        distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
      });
      previousScrollTop.current = scrollTop;
      if (resume) setBottomFollow(true);
    },
  };

  return {
    scrollRef,
    transcriptRef,
    transcriptKey,
    following: follow,
    followingRef: followRef,
    windowedMessages,
    filledMessages,
    hiddenCount,
    laterCount,
    olderPending,
    showEarlier,
    showLater,
    loadOlder,
    jumpToLatest,
    scrollToUnread,
    scrollHandlers,
  };
}
