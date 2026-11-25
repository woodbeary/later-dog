import type { NativeRun } from "../../shared/native-runs";
import type { LiveStep, ActivityKind } from "../../shared/step-words";
import type { WorkState } from "../../shared/work-state";
import type { DogState } from "./mascot";
import { liveStep, ageWords, helpersLine, outcomeKindOfTool } from "../../shared/step-words";
import { nativePuppies } from "../../shared/native-run-selectors";
import { workLine, sideJobCount } from "./work-line";

export const TURN_SLOT_SHOW_MS = 300;
export const TURN_SLOT_SETTLE_MS = 1_000;
export const TURN_SLOT_HOLD_MS = 2_500;
export const TURN_ROOM_SHARE = 0.4;

export interface TurnSlotLine {
  key: string;
  words: string;
  age: string | null;
  sideJobs: string | null;
  face: DogState;
  urgent: boolean;
  instant?: boolean;
  spoken: string;
  openDog?: string;
  destination: "work" | "side-jobs" | "card";
  wait: boolean;
}

export interface TurnSlotInput {
  working: boolean;
  busy?: boolean;
  name: string;
  turnKey: string;
  since?: number;
  run?: NativeRun;
  step?: LiveStep | null;
  work?: WorkState;
  now: number;
  kindStartedAt?: number;
  ask?: string | null;
  delivery?: { at: number; held?: boolean };
  readAt?: number;
}

const FACE: Record<ActivityKind, DogState> = {
  thinking: "thinking",
  reading: "searching",
  writing: "writing",
  editing: "working",
  running: "working",
  searching: "searching",
  web: "searching",
  page: "searching",
  screen: "searching",
  computer: "working",
  team: "listening",
  working: "working",
};

export function turnSlotLine(input: TurnSlotInput): TurnSlotLine | null {
  const { run, work, name, now, turnKey, delivery } = input;
  const make = (
    key: string,
    words: string,
    face: DogState,
    extra: Partial<TurnSlotLine> = {},
  ): TurnSlotLine => ({
    key: `${turnKey}:${key}`,
    words,
    face,
    age: null,
    sideJobs: null,
    urgent: false,
    spoken: [`${name}: ${words}`, extra.age, extra.sideJobs].filter(Boolean).join(" · ") + ".",
    destination: "work",
    wait: false,
    ...extra,
  });
  if (input.ask)
    return make("needs-you", input.ask, "alerting", { urgent: true, destination: "card" });
  if (work?.kind === "needs-you") {
    const words = work.hold
      ? `${work.hold.why === "off" ? "Turn on" : "Sign in to"} ${work.hold.account} to carry on`
      : "Waiting for your OK";
    return make("needs-you", words, "alerting", { urgent: true, destination: "card" });
  }
  if (delivery) {
    if (!delivery.held && now - delivery.at < 2_000) return null;
    return make(
      delivery.held ? "not-sent" : "sending",
      delivery.held ? "Not sent yet" : "Sending",
      "idle",
      { wait: true },
    );
  }
  if (input.working && input.readAt !== undefined && now - input.readAt < TURN_SLOT_HOLD_MS)
    return make(`read:${input.readAt}`, "Read your message", "listening", { instant: true });
  const age = ageWords(now - (input.since ?? run?.startedAt ?? now));
  if (input.working && work?.kind === "running" && (work.dogs?.length ?? 0) > 1) {
    const helpers = helpersLine(work.dogs!.map((dog) => ({ name: dog.name })))!;
    return make("dogs", helpers.text, "listening", { age });
  }
  const puppies = run
    ? nativePuppies(run).filter((actor) => actor.state === "running" && !actor.background).length
    : 0;
  if (
    input.working &&
    puppies > 0 &&
    (outcomeKindOfTool(run?.currentActivity?.label ?? "") === "help" ||
      run?.actors.find((actor) => actor.kind === "parent")?.state === "waiting")
  ) {
    return make(
      "puppies",
      `Getting help from ${puppies} ${puppies === 1 ? "puppy" : "puppies"}`,
      "listening",
      { age },
    );
  }
  if (input.busy === false && work?.kind === "running" && work.computerJobs) {
    const words =
      work.computerBackground === work.computerJobs
        ? "Still running a command"
        : "Running a command";
    return make(
      "computer-job",
      words,
      work.computerBackground === work.computerJobs ? "idle" : "working",
      { age: ageWords(now - (work.computerSince ?? input.since ?? now)), destination: "side-jobs" },
    );
  }
  const line = workLine({ ...input, sideJobs: sideJobCount(run, work) });
  if (!line) return null;
  if (line.kind === "helpers")
    return make(`helpers:${line.text}`, line.text, line.needsYou ? "alerting" : "listening", {
      urgent: line.needsYou,
      openDog: line.open,
      age,
    });
  if (line.kind === "waiting") {
    const until =
      work?.kind === "waiting-for-usage" && work.until
        ? new Date(work.until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
        : null;
    const words =
      work?.kind === "waiting-for-usage"
        ? until
          ? `Resting until ${until}`
          : "Resting until its limit resets"
        : line.text;
    return make(
      `wait:${words}`,
      words,
      work?.kind === "waiting-for-usage" ? "sleeping" : "listening",
      { wait: true, destination: words.includes("side job") ? "side-jobs" : "work" },
    );
  }
  const step = liveStep(run) ?? input.step;
  const nativeKind = run?.currentActivity?.kind;
  const words =
    nativeKind === "message"
      ? "Writing back"
      : nativeKind === "compaction"
        ? "Tidying up its notes"
        : line.phrase;
  const stepAge =
    line.age ?? (input.since !== undefined && !step ? ageWords(now - input.since) : null);
  return make(
    `step:${words}`,
    words,
    nativeKind === "message" ? "writing" : FACE[step?.kind ?? "working"],
    {
      age: stepAge,
      sideJobs: line.sideJobs,
      spoken: [`${name}: ${words}`, stepAge, line.sideJobs].filter(Boolean).join(" · ") + ".",
    },
  );
}

export interface PacedTurnLine {
  shown: TurnSlotLine | null;
  shownAt: number;
  pending: TurnSlotLine | null;
  pendingAt: number;
}

export const EMPTY_TURN_LINE: PacedTurnLine = {
  shown: null,
  shownAt: 0,
  pending: null,
  pendingAt: 0,
};

export function paceTurnLine(
  previous: PacedTurnLine,
  wanted: TurnSlotLine | null,
  now: number,
): PacedTurnLine {
  if (wanted === null) return { ...previous, pending: null };
  if (previous.shown?.key === wanted.key) return { ...previous, shown: wanted, pending: null };
  if (
    !previous.shown ||
    wanted.urgent ||
    previous.shown.urgent ||
    wanted.instant ||
    previous.shown.instant
  )
    return { shown: wanted, shownAt: now, pending: null, pendingAt: now };
  const pendingAt = previous.pending?.key === wanted.key ? previous.pendingAt : now;
  if (now - pendingAt >= TURN_SLOT_SETTLE_MS && now - previous.shownAt >= TURN_SLOT_HOLD_MS)
    return { shown: wanted, shownAt: now, pending: null, pendingAt: now };
  return { ...previous, pending: wanted, pendingAt };
}

export function turnRoomHeight(visibleHeight: number): number {
  return Math.max(0, Math.round(visibleHeight * TURN_ROOM_SHARE));
}

export function turnRoomRemaining(targetHeight: number, contentHeight: number): number {
  return Math.max(0, targetHeight - contentHeight);
}

export function turnInProgress(source: {
  busy?: boolean;
  waitingForTeammates?: boolean;
  work?: WorkState;
}): boolean {
  return Boolean(
    source.busy ||
    source.waitingForTeammates ||
    (source.work && source.work.kind !== "idle" && source.work.kind !== "stopped"),
  );
}
