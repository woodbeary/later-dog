import { useEffect, useRef, useState } from "react";
import { liveStep } from "../../shared/step-words";
import {
  EMPTY_TURN_LINE,
  paceTurnLine,
  turnSlotLine,
  TURN_SLOT_HOLD_MS,
  TURN_SLOT_SETTLE_MS,
  TURN_SLOT_SHOW_MS,
  type TurnSlotInput,
} from "./turn-slot";

export function useTurnSlotLine(input: Omit<TurnSlotInput, "now">) {
  const [, tick] = useState(0);
  const now = Date.now();
  const turn = useRef({
    key: input.turnKey,
    startedAt: now,
    paced: EMPTY_TURN_LINE,
    kind: "",
    kindSince: now,
  });
  if (turn.current.key !== input.turnKey)
    turn.current = {
      key: input.turnKey,
      startedAt: now,
      paced: EMPTY_TURN_LINE,
      kind: "",
      kindSince: now,
    };
  const current = liveStep(input.run) ?? input.step;
  const kind = current?.kind ?? "working";
  const kindStartedAt =
    turn.current.kind === kind
      ? turn.current.kindSince
      : (current?.startedAt ?? input.since ?? now);
  const wanted = turnSlotLine({ ...input, kindStartedAt, now });
  const startsAt = input.delivery?.at ?? input.since ?? turn.current.startedAt;
  const shown = Boolean(wanted && (wanted.urgent || now - startsAt >= TURN_SLOT_SHOW_MS));
  if (shown) turn.current.paced = paceTurnLine(turn.current.paced, wanted, now);
  const paced = turn.current.paced;
  if (wanted && paced.shown?.key === wanted.key && turn.current.kind !== kind) {
    turn.current.kind = kind;
    turn.current.kindSince = kindStartedAt;
  }
  const line = shown ? paced.shown : null;
  const deadlines = [
    startsAt + TURN_SLOT_SHOW_MS,
    ...(input.delivery ? [input.delivery.at + 2_000] : []),
    ...(input.readAt !== undefined ? [input.readAt + TURN_SLOT_HOLD_MS] : []),
    ...(paced.pending
      ? [Math.max(paced.pendingAt + TURN_SLOT_SETTLE_MS, paced.shownAt + TURN_SLOT_HOLD_MS)]
      : []),
    kindStartedAt + (Math.floor(Math.max(0, now - kindStartedAt) / 60_000) + 1) * 60_000,
    (current?.startedAt ?? startsAt) +
      (Math.floor(Math.max(0, now - (current?.startedAt ?? startsAt)) / 60_000) + 1) * 60_000,
  ];
  const nextAt = Math.min(...deadlines.filter((at) => at > now));
  useEffect(() => {
    if ((!input.working && !wanted) || !Number.isFinite(nextAt)) return;
    const timer = setTimeout(() => tick((value) => value + 1), Math.max(1, nextAt - Date.now()));
    return () => clearTimeout(timer);
  }, [input.working, wanted?.key, nextAt]);
  return { line, shown };
}
