import { ageWords, foldSentence, sideJobsWords, stepPhrase, type ActivityKind, type OutcomeKind } from "../../shared/step-words.ts";

export const PACE = {
  showAfterMs: 300,
  settleMs: 1_000,
  holdMs: 2_500,
  ageFromMs: 60_000,
  afterSpeechMs: 2_000,
  batchMs: 300,
  announceAfterMs: 10_000,
  roomShare: 0.4,
} as const;

export const SLOT = {
  mac: { height: 32, face: 24, gap: 10, text: 14, line: 20 },
  phone: { height: 44, above: 12, face: 28, gap: 12, text: 17, line: 24 },
} as const;

export type Face = "idle" | "thinking" | "working" | "searching" | "writing" | "listening" | "alerting" | "sleeping" | "waking";
export type Tone = "plain" | "asks" | "quiet";
export type Opens = "work" | "card" | "helper" | "side-jobs" | "account" | "nothing";
export type Announce = "now" | "if-it-lasts" | "never";
export type Group = "Delivery" | "Working" | "Waiting on you" | "Waiting on something else" | "Ends" | "Rooms";

export interface SlotLine {
  key: string;
  words: string;
  spoken: string;
  face: Face;
  tone: Tone;
  age: string | null;
  sideJobs: string | null;
  opens: Opens;
  urgent: boolean;
  announce: Announce;
}

export interface FoldForm {
  words: string;
  spoken: string;
}

export interface TurnState {
  id: string;
  group: Group;
  title: string;
  cause: string;
  source: string;
  line: SlotLine | null;
  fold?: FoldForm;
  outcome?: string;
  note?: string;
  speaker?: string;
}

export interface Example {
  name: string;
  helper: string;
  helpers: string[];
  account: string;
  other: string;
  reset: string;
}

export const EXAMPLE: Example = { name: "Scout", helper: "Pebble", helpers: ["Pebble", "Thistle"], account: "Work", other: "Personal", reset: "3:40" };

const MINUTE = 60_000;

function lowerFirst(text: string): string {
  return text.replace(/^[A-Z](?![A-Z])/, (letter) => letter.toLowerCase());
}

export function spokenAge(age: string): string {
  return age.replace(/\b1 hr\b/, "1 hour").replace(/\bhr\b/, "hours").replace(/\b1 min\b/, "1 minute").replace(/\bmin\b/, "minutes");
}

function listed(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length > 3) return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

const STEP_FACE: Record<ActivityKind, Face> = {
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

const GERUND: Readonly<Record<string, string>> = {
  run: "Running", check: "Checking", test: "Testing", build: "Building", install: "Installing", update: "Updating",
  fix: "Fixing", make: "Making", start: "Starting", find: "Finding", look: "Looking", open: "Opening",
};

export function subjectWords(outcome: OutcomeKind, subject: string | undefined): string | null {
  const plain = subject?.trim();
  if (!plain) return null;
  switch (outcome) {
    case "read": return `Reading the ${plain}`;
    case "edit": return `Changing the ${plain}`;
    case "wrote": return `Writing the ${plain}`;
    case "search": return `Searching for “${plain}”`;
    case "web": case "page": case "open": return `Looking up ${plain}`;
    case "command": case "check": case "cloud": {
      const [verb, ...rest] = plain.split(" ");
      const gerund = GERUND[verb!.toLowerCase()];
      return gerund ? [gerund, ...rest].join(" ") : null;
    }
    default: return null;
  }
}

function make(key: string, words: string, spoken: string, face: Face, extra: Partial<SlotLine> = {}): SlotLine {
  return { key, words, spoken, face, tone: "plain", age: null, sideJobs: null, opens: "work", urgent: false, announce: "never", ...extra };
}

function withAge(line: SlotLine, ms: number | null, spokenWith: (age: string) => string): SlotLine {
  const age = ms !== null && ms >= PACE.ageFromMs ? ageWords(ms) : null;
  return age ? { ...line, age, spoken: spokenWith(spokenAge(age)) } : line;
}

function withSideJobs(line: SlotLine, count: number): SlotLine {
  if (count <= 0) return line;
  const words = sideJobsWords(count);
  return { ...line, sideJobs: words, spoken: `${line.spoken} ${words} going too.` };
}

export interface StepFacts {
  kind: ActivityKind;
  runKey: string;
  runMs?: number;
  stepMs?: number;
  outcome?: OutcomeKind;
  subject?: string;
  sideJobs?: number;
}

export function stepLine(facts: StepFacts, name: string = EXAMPLE.name): SlotLine {
  const long = (facts.stepMs ?? 0) >= PACE.ageFromMs && facts.outcome ? subjectWords(facts.outcome, facts.subject) : null;
  const words = long ?? stepPhrase(facts.kind, facts.runKey);
  const key = long ? `subject:${facts.runKey}:${long}` : `${facts.kind}:${facts.runKey}`;
  const line = make(key, words, `${name} is ${lowerFirst(words)}.`, STEP_FACE[facts.kind]);
  const aged = withAge(line, long ? facts.stepMs ?? null : facts.runMs ?? null, (age) => `${name} has been ${lowerFirst(words)} ${age}.`);
  return withSideJobs(aged, facts.sideJobs ?? 0);
}

export function puppiesLine(count: number, name: string = EXAMPLE.name): SlotLine {
  const words = count === 1 ? "Getting help from a puppy" : `Getting help from ${count} puppies`;
  return make(`puppies:${count}`, words, `${name} is ${lowerFirst(words)}.`, "listening");
}

export function helpersWorkingLine(names: readonly string[], ms: number | null, name: string = EXAMPLE.name): SlotLine {
  const one = names.length === 1;
  const words = `${listed(names)} ${one ? "is" : "are"} working`;
  const line = make(`helpers:${names.join("|")}`, words, `${listed(names)} ${one ? "is" : "are"} working on it for ${name}.`, "listening");
  return withAge(line, ms, (age) => `${listed(names)} ${one ? "has" : "have"} been working on it for ${name} ${age}.`);
}

export function restingLine(account: string, reset: string | null, name: string = EXAMPLE.name): SlotLine {
  const words = reset ? `Resting until ${reset}` : "Resting until its limit resets";
  const spoken = reset ? `${name}'s ${account} account is resting until ${reset}. ${name} carries on then.` : `${name}'s ${account} account is resting until its limit resets.`;
  return make(`resting:${reset ?? ""}`, words, spoken, "sleeping", { tone: "quiet", announce: "if-it-lasts" });
}

export function turnStates(example: Example = EXAMPLE): TurnState[] {
  const { name, helper, helpers, account, other, reset } = example;
  const asks = (key: string, words: string, spoken: string, opens: Opens = "card"): SlotLine =>
    make(key, words, spoken, "alerting", { tone: "asks", opens, urgent: true, announce: "now" });
  const quiet = (key: string, words: string, spoken: string, face: Face, opens: Opens = "nothing"): SlotLine =>
    make(key, words, spoken, face, { tone: "quiet", opens, announce: "if-it-lasts" });
  const fold = foldSentence({ edit: 1, command: 1 })!;
  const firstFold = foldSentence({ edit: 1 })!;
  return [
    { id: "sending", group: "Delivery", title: "Sending", cause: "The send is still on its way after 2 s (an outbox attempt in flight).", source: "src/lib/outbox.ts PROGRESS_AFTER_MS, SendingTrack", line: quiet("sending", "Sending", `Your message to ${name} is on its way.`, "idle") },
    { id: "not-sent", group: "Delivery", title: "Not sent yet", cause: "The outbox holds the send: offline, a timeout, 502/503/504, 408 or 429.", source: "src/lib/outbox.ts sendOutcome", line: quiet("not-sent", "Not sent yet", `Your message to ${name} isn't sent yet. later.dog keeps trying.`, "idle") },
    { id: "waking-home", group: "Delivery", title: "Waking a sleeping home", cause: "A 503 that says waking or asleep; the request rides the wake for up to 2 min.", source: "shared/home-wake.ts, src/lib/api.ts", line: quiet("waking-home", "Waking up your home", `Your home is waking up. ${name} gets your message as soon as it is up.`, "waking") },
    { id: "home-busy", group: "Delivery", title: "Home busy", cause: "A 503 that says busy.", source: "shared/home-wake.ts", line: quiet("home-busy", "Waiting for your home", "Your home is busy. later.dog tries again in a moment.", "idle") },
    { id: "home-slow", group: "Delivery", title: "Home slow to wake", cause: "Waking took longer than 2 min; the outbox keeps holding the send.", source: "shared/home-wake.ts WAKE_TOO_LONG", line: quiet("home-slow", "Still waking your home", "Your home is taking longer than usual to wake up. later.dog keeps trying.", "sleeping") },
    { id: "queued", group: "Delivery", title: "Queued behind this turn", cause: "Sent with queue while a turn runs; it waits in pendingQueued.", source: "src/components/ComposerQueuedMessages.tsx", line: stepLine({ kind: "running", runKey: "queued-run" }, name), note: "The slot keeps the running turn's line; the queued message waits in the composer's queued strip, where it can be sent now." },
    { id: "read-steer", group: "Delivery", title: "Read your message", cause: "A message steered into the running turn was read (readAt).", source: "src/components/SendingTrack.tsx ReadReceipt", line: make("read-steer", "Read your message", `${name} read your message.`, "listening", { announce: "now" }), note: "Shown once for one hold, then the work line returns. Replaces the Sent and Read lines under the bubble." },
    { id: "thinking", group: "Working", title: "Thinking", cause: "The run is live with no current step, or the step is reasoning.", source: "shared/step-words.ts liveStep", line: stepLine({ kind: "thinking", runKey: "t1" }, name) },
    { id: "reading", group: "Working", title: "Reading", cause: "Current step is a read, view or open.", source: "shared/step-words.ts activityKindOfTool", line: stepLine({ kind: "reading", runKey: "r1" }, name) },
    { id: "searching", group: "Working", title: "Searching files", cause: "Current step is a search, find or list.", source: "shared/step-words.ts", line: stepLine({ kind: "searching", runKey: "s1" }, name) },
    { id: "web", group: "Working", title: "Looking something up", cause: "Current step is a web search, a page fetch or opening a site.", source: "shared/step-words.ts", line: stepLine({ kind: "web", runKey: "w1" }, name) },
    { id: "editing", group: "Working", title: "Changing things", cause: "Current step is an edit or a patch.", source: "shared/step-words.ts", line: stepLine({ kind: "editing", runKey: "e1" }, name) },
    { id: "writing-file", group: "Working", title: "Writing something new", cause: "Current step writes a new file.", source: "shared/step-words.ts", line: stepLine({ kind: "writing", runKey: "x1" }, name) },
    { id: "running", group: "Working", title: "Running a command", cause: "Current step is a shell command.", source: "shared/step-words.ts", line: stepLine({ kind: "running", runKey: "c1" }, name) },
    { id: "screen", group: "Working", title: "Using the screen", cause: "Current step is a screenshot, a click or typing on a computer.", source: "shared/step-words.ts", line: stepLine({ kind: "screen", runKey: "v1" }, name) },
    { id: "team", group: "Working", title: "Asking another dog", cause: "Current step coordinates with other dogs.", source: "shared/step-words.ts", line: stepLine({ kind: "team", runKey: "m1" }, name) },
    { id: "long-step", group: "Working", title: "One long step", cause: "One step has run a minute or more and the home sent a plain subject.", source: "NativeActivity.subject, currentActivity.startedAt", line: stepLine({ kind: "running", runKey: "c2", stepMs: 6 * MINUTE, outcome: "command", subject: "Run the order form tests" }, name) },
    { id: "long-run", group: "Working", title: "Same kind of step for minutes", cause: "Many short steps of one kind; the phrase stays and its age shows.", source: "liveStep, runs of one ActivityKind", line: stepLine({ kind: "reading", runKey: "r2", runMs: 3 * MINUTE }, name) },
    { id: "puppies", group: "Working", title: "Puppies helping", cause: "The current step hands work to native helpers inside the run.", source: "shared/native-run-selectors.ts nativePuppies", line: puppiesLine(3, name) },
    { id: "with-side-jobs", group: "Working", title: "Side jobs alongside", cause: "Background helpers or commands run while the dog keeps working.", source: "src/lib/work-line.ts sideJobCount", line: stepLine({ kind: "editing", runKey: "e2", sideJobs: 2 }, name), note: "The side jobs words open the side jobs page on their own." },
    { id: "side-jobs-wait", group: "Working", title: "Waiting on side jobs", cause: "The dog itself waits; only background work runs.", source: "src/lib/work-line.ts heldBySideJobs", line: make("side-jobs-wait", "Waiting on 2 side jobs", `${name} is waiting on 2 side jobs.`, "listening", { opens: "side-jobs" }) },
    { id: "writing-back", group: "Working", title: "Writing the reply", cause: "The current activity is the reply being written.", source: "NativeActivityKind message", line: make("writing-back", "Writing back", `${name} is writing back.`, "writing") },
    { id: "compacting", group: "Working", title: "Tidying its memory", cause: "The engine is summarizing earlier context.", source: "NativeActivityKind compaction", line: make("compacting", "Tidying up its notes", `${name} is tidying up its notes.`, "thinking") },
    { id: "helpers", group: "Working", title: "Other dogs working for this turn", cause: "work.kind waiting-on-dog: sent work that wants a reply is still open.", source: "server/laterdog/chat-work.ts handoffWait", line: helpersWorkingLine(helpers, 4 * MINUTE, name), note: "Taps open the work panel, which lists each dog and opens its chat." },
    { id: "computer-job", group: "Working", title: "A command still running", cause: "The turn ended but a job it started on its computer is alive.", source: "server/laterdog/computer-jobs.ts, work.computerJobs", line: withAge(make("computer-job", "Running a command", `${name} is running a command on its computer.`, "working", { opens: "side-jobs" }), 12 * MINUTE, (age) => `${name} has been running a command on its computer ${age}.`) },
    { id: "computer-background", group: "Working", title: "A command past two hours", cause: "work.computerBackground: past 2 h, or its computer cannot be read.", source: "server/laterdog/computer-runs.ts MAX_RUN_MS", line: withAge(quiet("computer-background", "Still running a command", `${name}'s command is still running on its computer.`, "idle", "side-jobs"), 125 * MINUTE, (age) => `${name}'s command has been running on its computer ${age}.`) },
    { id: "picking-up", group: "Working", title: "Picking up after a restart", cause: "A pickup turn: restart, stall watch or a finished command woke the dog.", source: "tool.pickup restart | watch | computer", line: make("picking-up", "Picking up where it left off", `${name} is picking up where it left off.`, "waking"), note: "The recovery line stays in the transcript as the record." },
    { id: "moving-account", group: "Working", title: "Moving to another account", cause: "The account hit its limit mid-turn and the turn carries on elsewhere.", source: "tool.carry, StatusActivityRow CarriedAccount", line: make("moving-account", `Moving to ${other}`, `${name} is moving to your ${other} account to carry on.`, "waking", { announce: "now" }), note: "Shown for one hold, then the work line returns. The move is recorded in How it ran." },
    { id: "needs-ok", group: "Waiting on you", title: "Approval", cause: "An open approval or device approval card.", source: "ApprovalCard, DeviceApprovalCard, activity waiting-on-you", line: asks("needs-ok", "Waiting for your OK", `${name} is waiting for your OK.`) },
    { id: "needs-answer", group: "Waiting on you", title: "Question", cause: "An open question, docked above the composer.", source: "QuestionCard, openQuestion", line: asks("needs-answer", "Waiting for your answer", `${name} has a question for you.`) },
    { id: "needs-details", group: "Waiting on you", title: "Secure form", cause: "A secure form or a secret request card.", source: "SecureFormCard, SecretRequestCard", line: asks("needs-details", "Waiting for your details", `${name} is waiting for you to fill in a form.`) },
    { id: "needs-sign-in", group: "Waiting on you", title: "Sign in to an app", cause: "A connector card asks the person to sign in.", source: "ConnectorCard", line: asks("needs-sign-in", "Waiting for you to sign in", `${name} is waiting for you to sign in.`) },
    { id: "your-turn-screen", group: "Waiting on you", title: "Take over the screen", cause: "A take-over card, or the computer's help reason.", source: "TakeoverCard, NeedsYouRow", line: asks("your-turn-screen", "Your turn at the screen", `${name} needs you to take over the screen.`) },
    { id: "helper-needs-you", group: "Waiting on you", title: "A helper dog asks", cause: "waiting-on-dog with a dog whose ask is set.", source: "shared/step-words.ts helpersLine", line: asks("helper-needs-you", `${helper} needs your answer`, `${helper} needs your answer.`, "helper") },
    { id: "needs-account", group: "Waiting on you", title: "Account off or signed out", cause: "needs-you with an account hold: off or signed-out.", source: "shared/work-state.ts AccountHold", line: asks("needs-account", `Sign in to ${account} to carry on`, `${name} can carry on once you sign in to ${account}.`, "account") },
    { id: "resting", group: "Waiting on something else", title: "Usage limit", cause: "waiting-for-usage with the time it resets.", source: "shared/work-state.ts, src/lib/account-rests.ts", line: restingLine(account, reset, name) },
    { id: "resting-unknown", group: "Waiting on something else", title: "Usage limit, no time", cause: "waiting-for-usage without a reset time.", source: "shared/work-state.ts", line: restingLine(account, null, name) },
    { id: "waiting-computer", group: "Waiting on something else", title: "Computer in use", cause: "waiting-for-computer: another chat holds the computer.", source: "src/lib/work-state.ts turn.wait_started", line: quiet("waiting-computer", "Waiting for its computer", `${name} is waiting for its computer while ${helper} uses it.`, "idle", "work") },
    { id: "trying-again", group: "Waiting on something else", title: "Reconnecting", cause: "retrying: the turn is reconnecting to its engine.", source: "src/lib/work-state.ts turn.retrying", line: quiet("trying-again", "Trying again", `${name} lost its connection for a moment and is trying again.`, "thinking", "work") },
    { id: "finished", group: "Ends", title: "Finished", cause: "The reply arrived and the run ended.", source: "src/components/FoldLine.tsx, turnFolds", line: null, fold: { words: fold, spoken: `${name} finished. ${fold}.` }, outcome: "The reply lands below the fold line." },
    { id: "finished-plain", group: "Ends", title: "Finished, no steps", cause: "The reply arrived and the run had no steps.", source: "ChatView MessagesList", line: null, outcome: "The reply takes the slot's place." },
    { id: "stopped-you", group: "Ends", title: "Stopped by you", cause: "The person pressed Stop.", source: "shared/work-state.ts stopped cause you", line: null, fold: { words: `Stopped by you · ${firstFold}`, spoken: `You stopped ${name}. ${firstFold}.` } },
    { id: "stopped-engine", group: "Ends", title: "Stopped early", cause: "The engine closed before the turn finished.", source: "work stopped detail closed", line: null, fold: { words: "Stopped before it finished", spoken: `${name} stopped before it finished.` } },
    { id: "stopped-stalled", group: "Ends", title: "Stopped after a stall", cause: "The stall watch ended a turn that made no progress.", source: "work stopped detail stalled", line: null, fold: { words: "Stopped: no progress for too long", spoken: `${name} stopped because it made no progress for too long.` } },
    { id: "failed", group: "Ends", title: "Failed", cause: "An error ended the turn; the error row is the outcome.", source: "src/components/FailedTurnRow.tsx", line: null, fold: { words: fold, spoken: `${fold}.` }, outcome: "The error row lands below the fold line, with its own action." },
    { id: "after-side-jobs", group: "Ends", title: "Side jobs after the reply", cause: "The reply landed and background work still runs.", source: "src/components/FoldLine.tsx SideJobsStillGoing", line: null, fold: { words: "2 side jobs still going", spoken: "2 side jobs are still going." }, outcome: "A quiet line under the reply until they end." },
    { id: "room-one", group: "Rooms", title: "One dog working", cause: "group.busyBotId: one member is speaking.", source: "src/components/GroupView.tsx", line: stepLine({ kind: "reading", runKey: "room-r1" }, helper), speaker: helper },
    { id: "room-many", group: "Rooms", title: "Several dogs working", cause: "group.work running with dogs.", source: "shared/work-state.ts running dogs", line: make("room-many", `${listed(helpers)} are working`, `${listed(helpers)} are working.`, "working"), speaker: helpers[0] },
    { id: "room-asks", group: "Rooms", title: "A dog in the room asks", cause: "An approval card from one member.", source: "RoomTranscript approval cards", line: asks("room-asks", "Waiting for your OK", `${helper} is waiting for your OK.`), speaker: helper },
  ];
}

export interface Paced {
  shown: SlotLine | null;
  shownAt: number;
  pending: SlotLine | null;
  pendingAt: number;
}

export const NOTHING_SHOWN: Paced = { shown: null, shownAt: 0, pending: null, pendingAt: 0 };

export function pace(previous: Paced, wanted: SlotLine | null, now: number): Paced {
  if (wanted === null) return { ...previous, pending: null };
  const shown = previous.shown;
  if (shown !== null && wanted.key === shown.key) return { ...previous, shown: wanted, pending: null };
  if (shown === null || wanted.urgent || shown.urgent) return { shown: wanted, shownAt: now, pending: null, pendingAt: now };
  const pendingAt = previous.pending?.key === wanted.key ? previous.pendingAt : now;
  if (now - pendingAt >= PACE.settleMs && now - previous.shownAt >= PACE.holdMs) return { shown: wanted, shownAt: now, pending: null, pendingAt: now };
  return { ...previous, pending: wanted, pendingAt };
}

export interface BusyStep {
  at: number;
  kind: ActivityKind | "writing-back";
  id: string;
  outcome?: OutcomeKind;
  subject?: string;
}

export const BUSY_TURN: { prompt: string; reply: string; landsAt: number; steps: BusyStep[] } = {
  prompt: "Can you get the order form working again?",
  reply: "reply to: Can you get the order form working again?",
  landsAt: 77_500,
  steps: [
    { at: 0, kind: "thinking", id: "t0" },
    { at: 1_000, kind: "reading", id: "read-order-form", outcome: "read", subject: "order form" },
    { at: 1_400, kind: "thinking", id: "t1" },
    { at: 1_700, kind: "reading", id: "read-spring-menu", outcome: "read", subject: "spring menu" },
    { at: 2_000, kind: "editing", id: "edit-spring-menu", outcome: "edit", subject: "spring menu" },
    { at: 2_500, kind: "thinking", id: "t2" },
    { at: 2_900, kind: "running", id: "run-tests", outcome: "command", subject: "Run the order form tests" },
    { at: 75_000, kind: "thinking", id: "t3" },
    { at: 76_000, kind: "writing-back", id: "w0" },
  ],
};

export function busyWanted(at: number, name: string = EXAMPLE.name, turnKey = "busy-turn"): SlotLine | null {
  const steps = BUSY_TURN.steps.filter((step) => step.at <= at);
  const current = steps.at(-1);
  if (!current) return null;
  if (current.kind === "writing-back") return turnStates().find((state) => state.id === "writing-back")!.line;
  const kind = current.kind;
  let runStart = current.at;
  for (let index = steps.length - 2; index >= 0; index -= 1) {
    const step = steps[index]!;
    const ends = steps[index + 1]!.at;
    if (step.kind === kind) runStart = step.at;
    else if (!(step.kind === "thinking" && ends - step.at < PACE.settleMs)) break;
  }
  return stepLine({ kind, runKey: turnKey, runMs: at - runStart, stepMs: at - current.at, outcome: current.outcome, subject: current.subject }, name);
}

export function busyTimeline(until: number = BUSY_TURN.landsAt, tick = 100): Array<{ at: number; shown: SlotLine | null }> {
  const frames: Array<{ at: number; shown: SlotLine | null }> = [];
  let paced = NOTHING_SHOWN;
  for (let at = PACE.showAfterMs; at < until; at += tick) {
    paced = pace(paced, busyWanted(at), at);
    frames.push({ at, shown: paced.shown });
  }
  return frames;
}

export function visibleChanges(frames: ReadonlyArray<{ at: number; shown: SlotLine | null }>): Array<{ at: number; words: string }> {
  const changes: Array<{ at: number; words: string }> = [];
  for (const frame of frames) {
    const words = frame.shown ? [frame.shown.words, frame.shown.age, frame.shown.sideJobs].filter(Boolean).join(" · ") : "";
    if (changes.at(-1)?.words !== words) changes.push({ at: frame.at, words });
  }
  return changes;
}

export function roomFor(visibleHeight: number, slotHeight: number): number {
  return Math.max(slotHeight, Math.round(visibleHeight * PACE.roomShare));
}
