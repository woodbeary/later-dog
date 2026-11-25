import { useLayoutEffect, useRef, type RefObject } from "react";
import { boxOf } from "@/lib/scroll-anchor";
import { turnRoomHeight, turnRoomRemaining } from "@/lib/turn-slot";

export interface TurnLanding {
  key: string;
  active: boolean;
  delivering?: boolean;
  replyId?: string;
  topInset?: number;
  bottomInset?: number;
}

interface Anchor {
  id: string;
  top: number;
  offset: number;
}

interface Frame {
  thread: string;
  firstId?: string;
  anchor: Anchor | null;
}

function viewportScale(scroller: HTMLElement): number {
  const scale = scroller.clientHeight > 0 ? scroller.getBoundingClientRect().height / scroller.clientHeight : 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function viewportTopInset(scroller: HTMLElement, turn?: TurnLanding): number {
  const measured = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop);
  return Number.isFinite(measured) ? Math.max(0, measured) : turn?.topInset ?? 0;
}

export function useTurnLanding({
  scrollRef, transcriptRef, followingRef, setFollowing, threadKey, firstId, turn, settling = false,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  transcriptRef: RefObject<HTMLDivElement | null>;
  followingRef: RefObject<boolean>;
  setFollowing: (following: boolean) => void;
  threadKey: string;
  firstId?: string;
  turn?: TurnLanding;
  settling?: boolean;
}) {
  const roomRef = useRef<HTMLDivElement>(null);
  const previous = useRef<Frame | null>(null);
  const record = useRef({ thread: threadKey, key: "", delivery: Boolean(turn?.delivering), active: false, held: false, opening: false, landed: false, target: 0, replyId: turn?.replyId });
  const latest = useRef({ turn, threadKey, firstId, settling });
  latest.current = { turn, threadKey, firstId, settling };
  const current = record.current;
  const holdsViewport = Boolean(turn && (turn.active || current.thread === threadKey && current.held));
  const pinFollowingRef = useRef(false);
  pinFollowingRef.current = followingRef.current && !holdsViewport;

  const remember = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const scale = viewportScale(scroller);
    const top = bounds.top;
    const bottom = bounds.bottom - (latest.current.turn?.bottomInset ?? 0) * scale;
    let anchor: Anchor | null = null;
    let last: Anchor | null = null;
    for (const row of scroller.querySelectorAll<HTMLElement>("[data-mid]")) {
      const rect = boxOf(row);
      if (!rect) continue;
      last = { id: row.dataset.mid ?? "", top: rect.top, offset: (rect.top - top) / scale + scroller.scrollTop };
      if (rect.bottom > top + viewportTopInset(scroller, latest.current.turn) * scale && rect.top < bottom) {
        anchor = last;
        break;
      }
    }
    if (!anchor && record.current.held && followingRef.current) anchor = last;
    previous.current = { thread: latest.current.threadKey, firstId: latest.current.firstId, anchor };
  };
  const hold = () => {
    const scroller = scrollRef.current;
    const before = previous.current;
    if (!scroller || !before?.anchor || before.thread !== latest.current.threadKey) return 0;
    const row = [...scroller.querySelectorAll<HTMLElement>("[data-mid]")].find(candidate => candidate.dataset.mid === before.anchor!.id);
    const rect = row ? boxOf(row) : null;
    if (!rect) return 0;
    const scale = viewportScale(scroller);
    const offset = (rect.top - scroller.getBoundingClientRect().top) / scale + scroller.scrollTop;
    const removed = before.firstId !== latest.current.firstId ? offset - before.anchor.offset : 0;
    const shift = rect.top - before.anchor.top;
    if (Math.abs(shift) > 0.01) scroller.scrollTop += shift / scale;
    return removed;
  };
  const consume = () => {
    const transcript = transcriptRef.current;
    const room = roomRef.current;
    if (!transcript || !room || !record.current.held) return;
    const scale = scrollRef.current ? viewportScale(scrollRef.current) : 1;
    const roomHeight = room.getBoundingClientRect().height / scale;
    const content = transcript.getBoundingClientRect().height / scale - roomHeight;
    const height = turnRoomRemaining(record.current.target, content);
    if (Math.abs(height - roomHeight) > 0.01) room.style.height = `${height}px`;
  };

  const finishOpening = () => {
    const state = record.current;
    if (!state.opening) return;
    if (!latest.current.turn?.active || state.landed || !state.held || !followingRef.current) {
      state.opening = false;
      return;
    }
    if (latest.current.settling) return;
    const scroller = scrollRef.current;
    const transcript = transcriptRef.current;
    const room = roomRef.current;
    if (!scroller || !transcript || !room) return;
    const measured = room.getBoundingClientRect().height / viewportScale(scroller);
    const visible = Math.max(0, scroller.clientHeight - viewportTopInset(scroller, latest.current.turn) - (latest.current.turn?.bottomInset ?? 0));
    const wanted = turnRoomHeight(visible);
    if (Math.abs(wanted - (Number.parseFloat(room.style.height) || 0)) > 0.01) {
      state.target = transcript.getBoundingClientRect().height / viewportScale(scroller) - measured + wanted;
      room.style.height = `${wanted}px`;
      return;
    }
    if (Math.abs(measured - wanted) > 0.01) return;
    scroller.scrollTo({ top: scroller.scrollHeight });
    state.opening = false;
  };

  useLayoutEffect(() => {
    if (!turn) return;
    const scroller = scrollRef.current;
    const transcript = transcriptRef.current;
    const room = roomRef.current;
    if (!scroller || !transcript || !room) return;
    let state = record.current;
    if (state.thread !== threadKey) {
      state = { thread: threadKey, key: "", delivery: Boolean(turn?.delivering), active: false, held: false, opening: false, landed: false, target: 0, replyId: turn.replyId };
      record.current = state;
      previous.current = null;
      room.style.height = "0px";
    }
    if (turn.active && state.delivery && state.key !== turn.key) {
      state.key = turn.key;
      state.delivery = false;
    }
    const begins = turn.active && (!state.active || !state.delivery && state.key !== turn.key);
    if (begins) {
      const contentHeight = (transcript.getBoundingClientRect().height - room.getBoundingClientRect().height) / viewportScale(scroller);
      room.style.height = "0px";
      state.key = turn.key;
      state.delivery = Boolean(turn.delivering);
      state.replyId = turn.replyId;
      state.held = followingRef.current;
      state.opening = state.held;
      state.landed = false;
      if (state.held) {
        const visible = Math.max(0, scroller.clientHeight - viewportTopInset(scroller, turn) - (turn.bottomInset ?? 0));
        const height = turnRoomHeight(visible);
        state.target = contentHeight + height;
        room.style.height = `${height}px`;
        scroller.scrollTo({ top: scroller.scrollHeight });
      }
    } else {
      if (state.held || !followingRef.current || previous.current?.firstId !== firstId) {
        state.target += hold();
      }
      consume();
      if (state.held && (state.replyId !== turn.replyId || state.active && !turn.active && !state.delivery)) {
        state.landed = true;
        state.replyId = turn.replyId;
        state.delivery = false;
        const padding = Number.parseFloat(getComputedStyle(transcript).paddingBottom) || 0;
        const scale = viewportScale(scroller);
        const contentBottom = transcript.getBoundingClientRect().bottom - room.getBoundingClientRect().height - padding * scale;
        const visibleBottom = scroller.getBoundingClientRect().bottom - (turn.bottomInset ?? 0) * scale;
        if (contentBottom > visibleBottom + 0.5) setFollowing(false);
      }
    }
    if (!turn.active) state.opening = false;
    state.active = turn.active || state.delivery;
    finishOpening();
    remember();
  });

  useLayoutEffect(() => {
    if (!turn) return;
    const scroller = scrollRef.current;
    const transcript = transcriptRef.current;
    if (!scroller || !transcript) return;
    const onScroll = () => remember();
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("[data-mid]")) remember();
    };
    const observer = new ResizeObserver(() => {
      if (record.current.held || !followingRef.current) hold();
      consume();
      finishOpening();
      remember();
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    transcript.addEventListener("animationend", onAnimationEnd);
    transcript.addEventListener("animationcancel", onAnimationEnd);
    observer.observe(transcript);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      transcript.removeEventListener("animationend", onAnimationEnd);
      transcript.removeEventListener("animationcancel", onAnimationEnd);
      observer.disconnect();
    };
  }, [threadKey, Boolean(turn)]);

  const release = () => {
    if (!turn) return;
    const room = roomRef.current;
    if (room) room.style.height = "0px";
    record.current.opening = false;
    record.current.held = Boolean(turn?.active);
    record.current.target = (transcriptRef.current?.getBoundingClientRect().height ?? 0) / (scrollRef.current ? viewportScale(scrollRef.current) : 1);
    pinFollowingRef.current = followingRef.current && !turn?.active;
    remember();
  };

  return { roomRef, pinFollowingRef, holdsViewport, release };
}
