import type { NativeRun } from "./native-runs.ts";

export type ActivityKind = "thinking" | "reading" | "writing" | "editing" | "running" | "searching" | "web" | "page" | "screen" | "computer" | "team" | "working";
export type OutcomeKind = "edit" | "command" | "check" | "cloud" | "read" | "wrote" | "search" | "chats" | "web" | "page" | "open" | "screen" | "computer" | "team" | "phone" | "delete" | "dog" | "note" | "help" | "plan" | "tool";
export interface LiveStep { id: string; kind: ActivityKind; startedAt: number; lastActivityAt: number }

const OUTCOMES: Array<[RegExp, OutcomeKind]> = [
  [/^(?:run_on_computer|computer_exec|vm_exec)$/, "cloud"],
  [/^(?:bash|shell|terminal|run_command|execute|exec_command|exec|local_shell|mac_run_command|killshell|kill_shell|killbash|kill_bash|command_stop)$/, "command"],
  [/^(?:bashoutput|bash_output|write_stdin|command_output|command_input)$/, "check"],
  [/^(?:read|read_file|view|notebookread|open_file|tool_result_read|mac_read_file)$/, "read"],
  [/^(?:write|create_file|write_file|mac_write_file)$/, "wrote"],
  [/^(?:edit|multiedit|apply_patch|str_replace|str_replace_editor|str_replace_based_edit_tool|notebookedit|edit_file)$/, "edit"],
  [/^delete_file$/, "delete"],
  [/^(?:grep|glob|find|search|ls|list_files|search_files|mac_list_files)$/, "search"],
  [/^(?:web_?search|search_web)$/, "web"],
  [/^(?:web_?fetch|fetch|fetch_url|read_page)$/, "page"],
  [/^(?:open_url|navigate|browser_navigate)$/, "open"],
  [/^(?:screenshot|screen_capture|computer_screenshot|browser_screenshot)$/, "screen"],
  [/^(?:click|double_click|right_click|type_text|press_key|key|key_press|hotkey|scroll|drag|move|move_cursor|computer|computer_batch|computer_use|computer_tools|computer_call|mac_computer_call|fill_secure_field|shared_computer|select_computer|browser_.+)$/, "computer"],
  [/^(?:read_phone|add_to_phone|change_on_phone)$/, "phone"],
  [/^create_bot$/, "dog"],
  [/^(?:coordinate_bots|list_bots|list_agents|listagents|start_tasks|ask_bot|send_message|post_to_room|delegate_bot|list_rooms|create_room|manage_room)$/, "team"],
  [/^(?:memory_update|memory_log)$/, "note"],
  [/^(?:session_search|session_read)$/, "chats"],
  [/^(?:todowrite|todo_write|update_plan|set_plan)$/, "plan"],
  [/^(?:task|agent|spawn_agent)$/, "help"],
];

const ACTIVITIES: Partial<Record<OutcomeKind, ActivityKind>> = {
  command: "running", check: "running", cloud: "running", read: "reading", wrote: "writing", edit: "editing", delete: "editing",
  search: "searching", chats: "searching", web: "web", page: "page", open: "page", screen: "screen", computer: "computer", team: "team",
};

const LOOKING_UP = ["Looking it up", "Reading up on it"];
const LOOKING_AT = ["Looking at the screen", "Taking a look", "Clicking around"];
const PHRASES: Record<ActivityKind, string[]> = {
  thinking: ["Thinking it over", "Working it out", "Sorting it out"],
  reading: ["Doing some reading", "Reading it through", "Going through it"],
  writing: ["Writing it up", "Putting it into words"],
  editing: ["Making changes", "Tidying it up"],
  running: ["Trying it out", "Checking the result"],
  searching: ["Looking around", "Digging through it"],
  web: LOOKING_UP,
  page: LOOKING_UP,
  screen: LOOKING_AT,
  computer: LOOKING_AT,
  team: ["Checking in with the others"],
  working: ["Working on it"],
};

interface Fold { kinds: OutcomeKind[]; one: string; many: string }
const FOLDS: Fold[] = [
  { kinds: ["edit"], one: "made a change", many: "made # changes" },
  { kinds: ["command", "check", "cloud"], one: "tried something", many: "tried # things" },
  { kinds: ["read"], one: "looked through one thing", many: "looked through # things" },
  { kinds: ["wrote"], one: "wrote one thing", many: "wrote # things" },
  { kinds: ["search", "chats"], one: "searched once", many: "searched # times" },
  { kinds: ["web", "page", "open"], one: "looked something up", many: "looked up # things" },
  { kinds: ["screen", "computer"], one: "looked at the screen", many: "looked at the screen # times" },
  { kinds: ["team"], one: "asked a dog", many: "asked # dogs" },
  { kinds: ["phone"], one: "used your iPhone", many: "used your iPhone # times" },
  { kinds: ["delete"], one: "removed something", many: "removed # things" },
  { kinds: ["dog"], one: "made a new dog", many: "made # new dogs" },
  { kinds: ["note"], one: "made a note", many: "made # notes" },
  { kinds: ["help"], one: "got some help", many: "got help # times" },
  { kinds: ["tool"], one: "did something", many: "did # things" },
];

const PAST = new Map([
  ["run", "Ran"], ["check", "Checked"], ["test", "Tested"], ["build", "Built"], ["install", "Installed"], ["start", "Started"],
  ["open", "Opened"], ["make", "Made"], ["add", "Added"], ["remove", "Removed"], ["update", "Updated"], ["fix", "Fixed"],
  ["find", "Found"], ["list", "Listed"], ["show", "Showed"], ["get", "Got"], ["look", "Looked"], ["create", "Created"],
]);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUTE = 60_000;

function bareToolName(name: string): string {
  return name.trim().toLowerCase().replace(/^(?:mcp__.+?|[a-z][a-z0-9_-]{0,31})__/, "").split(":", 1)[0]!.trim();
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.replace(/^[A-Z](?![A-Z])/, letter => letter.toLowerCase());
}

function pastTense(text: string): string {
  const match = /^(\S+)([\s\S]*)$/.exec(text);
  const past = match ? PAST.get(match[1]!.toLowerCase()) : undefined;
  return past ? past + match![2]! : capitalised(text);
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function duration(ms: number): string | null {
  const minutes = Math.floor(ms / MINUTE);
  if (!(minutes >= 1)) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function listed(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length > 3) return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export function outcomeKindOfTool(toolName: string): OutcomeKind {
  const bare = bareToolName(toolName);
  return OUTCOMES.find(([pattern]) => pattern.test(bare))?.[1] ?? "tool";
}

export function activityKindOfTool(toolName: string): ActivityKind {
  return ACTIVITIES[outcomeKindOfTool(toolName)] ?? "working";
}

export function stepPhrase(kind: ActivityKind, stepId: string): string {
  const phrases = PHRASES[kind] ?? PHRASES.working;
  return phrases[hash(stepId) % phrases.length]!;
}

export function ageWords(ms: number): string | null {
  const words = duration(ms);
  return words ? `for ${words}` : null;
}

export function lastMovedWords(ms: number): string {
  const minutes = Math.floor(ms / MINUTE);
  if (!(minutes >= 1)) return "just now";
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago`;
}

export function goingWords(ms: number): string {
  const age = ageWords(ms);
  return age ? `Going ${age}` : "Just started";
}

export function foldSentence(counts: Partial<Record<OutcomeKind, number>>): string | null {
  const groups = FOLDS
    .map((fold, order) => ({ fold, order, count: fold.kinds.reduce((sum, kind) => sum + Math.max(0, counts[kind] ?? 0), 0) }))
    .filter(group => group.count > 0);
  if (!groups.length) return null;
  const named = [...groups].sort((a, b) => b.count - a.count || a.order - b.order).slice(0, 2).sort((a, b) => a.order - b.order);
  const clauses = named.map(({ fold, count }) => count === 1 ? fold.one : fold.many.replace("#", String(count)));
  const [first, second] = clauses;
  if (first && second && /\bthings?$/.test(first) && /\bthings?$/.test(second)) clauses[1] = second.replace(/ things?$/, "");
  return capitalised(clauses.join(", ") + (groups.length > named.length ? " and more" : ""));
}

export function stepLabel(step: { outcome: OutcomeKind; state: "done" | "failed"; subject?: string; helperName?: string }): string {
  const subject = step.subject?.trim();
  const plain = capitalised(FOLDS.find(fold => fold.kinds.includes(step.outcome))?.one ?? "updated the plan");
  if (step.outcome === "screen" || step.outcome === "computer") return "Looked at the screen";
  if (!subject) return plain;
  switch (step.outcome) {
    case "edit": return `Changed the ${subject}`;
    case "read": return `Read the ${subject}`;
    case "wrote": return `Wrote the ${subject}`;
    case "delete": return `Removed the ${subject}`;
    case "command": case "check": case "cloud": return pastTense(subject);
    case "help": return `Asked a puppy to ${lowerFirst(subject)}`;
    case "team": return step.helperName?.trim() ? `Asked ${step.helperName.trim()} to ${lowerFirst(subject)}` : plain;
    case "search": case "chats": return `Searched for “${subject}”`;
    case "web": case "page": case "open": return `Looked up ${subject}`;
    default: return plain;
  }
}

export function sideJobsWords(count: number): string {
  return `${count} side ${count === 1 ? "job" : "jobs"}`;
}

export function sideJobsStillGoing(count: number): string {
  return `${sideJobsWords(count)} still going`;
}

export function helpersLine(helpers: Array<{ name: string; state?: "queued" | "running" | "needsYou" }>): { text: string; needsYou: boolean } | null {
  const asking = helpers.filter(helper => helper.state === "needsYou").map(helper => helper.name);
  if (asking.length) return { text: `${listed(asking)} ${asking.length === 1 ? "needs" : "need"} your answer`, needsYou: true };
  const working = helpers.map(helper => helper.name);
  if (!working.length) return null;
  return { text: `${listed(working)} ${working.length === 1 ? "is" : "are"} working`, needsYou: false };
}

export function stepTime(startedAt: number, now: number): string {
  const start = new Date(startedAt);
  const clock = `${start.getHours() % 12 || 12}:${String(start.getMinutes()).padStart(2, "0")}`;
  const day = startOfDay(startedAt);
  const today = startOfDay(now);
  if (day === today) return clock;
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6);
  if (day < today && day >= weekAgo.getTime()) return `${DAYS[start.getDay()]!} ${clock}`;
  return `${MONTHS[start.getMonth()]!} ${start.getDate()} ${clock}`;
}

export function liveStep(run: NativeRun | undefined): LiveStep | null {
  if (!run || run.observation !== "live") return null;
  const current = run.currentActivity;
  if (!current) {
    const startedAt = run.lastActivityAt ?? run.startedAt;
    return { id: `${run.id}:thinking:${run.activityCount}`, kind: "thinking", startedAt, lastActivityAt: run.lastActivityAt ?? startedAt };
  }
  const kind: ActivityKind = current.kind === "reasoning" ? "thinking" : current.kind === "search" ? "searching" : current.kind === "tool" ? activityKindOfTool(current.label) : "working";
  const startedAt = current.startedAt ?? run.lastActivityAt ?? run.startedAt;
  return { id: current.id, kind, startedAt, lastActivityAt: run.lastActivityAt ?? startedAt };
}
