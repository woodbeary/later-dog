import type { Store } from "../store.ts";
import { teammateEndLabel, type HandoffEnd } from "./handoff-budget.ts";

type NameOf = (idOrName: string) => string | undefined;

const TEAM_TOOLS: Record<string, (input: Record<string, unknown>, nameOf: NameOf) => string> = {
  coordinate_bots: (input, nameOf) => checkingWith(names(input.bot_ids, nameOf)),
  create_bot: (input) => (typeof input.name === "string" && input.name.trim() ? `making ${clipName(input.name)}` : "making a new dog"),
  shared_computer: (input) => onTheMac(input),
  read_phone: (input) => onThePhone(input),
  add_to_phone: (input) => onThePhone(input),
  change_on_phone: (input) => changingOnThePhone(input),
  start_tasks: (input) => startingTasks(input),
  send_text: () => "sending a text",
  read_texts: (input) => (typeof input.with === "string" && input.with.trim() ? `reading texts with ${clipName(input.with)}` : "reading your texts"),
  send_email: () => "sending an email",
};

function startingTasks(input: Record<string, unknown>): string {
  const count = Array.isArray(input.tasks) ? input.tasks.length : 0;
  return count > 1 ? `starting ${count} tasks` : "starting a task";
}

function fileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = value.trim().replace(/\/+$/, "").split("/").pop();
  return base ? clipName(base) : null;
}

function commandName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const words = value.replace(/^\s*(export\s+\S+\s*;\s*|cd\s+\S+\s*(&&|;)\s*)+/, "").trim().split(/\s+/);
  const head = words[0] === "pnpm" && words[1] === "exec" ? words[2] : words[0] === "git" || words[0] === "pnpm" ? `${words[0]} ${words[1] ?? ""}`.trim() : words[0];
  return head ? clipName(head.split("/").pop()!) : null;
}

function onThePhone(input: Record<string, unknown>): string {
  switch (input.what) {
    case "calendar": return "checking your calendar";
    case "reminders": return "checking your reminders";
    case "contacts": return typeof input.query === "string" && input.query.trim() ? `looking up ${clipName(input.query.trim())}` : "looking through your contacts";
    case "location": return "checking where you are";
    case "calendar_event": return "adding to your calendar";
    case "reminder": return "adding a reminder";
    default: return "using your iPhone";
  }
}

function changingOnThePhone(input: Record<string, unknown>): string {
  if (input.what === "reminder") return input.completed === true ? "ticking off a reminder" : "updating a reminder";
  return input.what === "calendar_event" ? "changing an event on your calendar" : "using your iPhone";
}

function onTheMac(input: Record<string, unknown>): string {
  const file = fileName(input.path);
  switch (input.action) {
    case "run_command": { const name = commandName(input.command); return name ? `running ${name} on your Mac` : "running a command on your Mac"; }
    case "command_output": case "command_input": return "checking a command on your Mac";
    case "command_stop": return "stopping a command on your Mac";
    case "read_file": return file ? `reading ${file} on your Mac` : "reading a file on your Mac";
    case "write_file": case "edit_file": return file ? `editing ${file} on your Mac` : "editing a file on your Mac";
    case "delete_file": return file ? `deleting ${file} on your Mac` : "deleting a file on your Mac";
    case "list_files": case "search_files": return "looking through files on your Mac";
    case "computer_tools": case "computer_call": return "using your Mac's screen";
    default: return "using your Mac";
  }
}

const SHELL_TOOL = /^(bash|shell|terminal|run_command|execute|exec_command|computer_exec|vm_exec|local_shell)$/;
const DESCRIPTION_CHARS = 60;

function describedCommand(input: unknown): string | null {
  const fields = record(input);
  for (const field of [fields.description, fields.justification]) {
    if (typeof field !== "string") continue;
    const flat = field.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const clipped = flat.length > DESCRIPTION_CHARS ? `${flat.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}\u2026` : flat;
    return /^[A-Z][^A-Z]/.test(clipped) || /^[A-Z]$/.test(clipped) ? `${clipped[0]!.toLowerCase()}${clipped.slice(1)}` : clipped;
  }
  return null;
}

const PHRASES: Array<[RegExp, string]> = [
  [/^delegate_cloud_job$/, "starting a cloud task"],
  [/^(inspect_cloud_job|review_cloud_job|collect_cloud_diff|reconcile_cloud_task|list_provider_tasks|record_job_observation)$/, "checking on a cloud task"],
  [/^correct_cloud_job$/, "sending a fix to a cloud task"],
  [/^list_bots$/, "checking who's around"],
  [/^(request_credential|request_takeover|request_secure_form)$/, "needs your input"],
  [/^fill_secure_field$/, "signing in"],
  [/^(select_computer|list_shared_computers)$/, "picking a computer"],
  [/^(memory_update|memory_log)$/, "making a note"],
  [/^(session_search|session_read)$/, "looking back through chats"],
  [/^(skills_list|skill_manage)$/, "learning a trick"],
  [/^(list_routines|propose_routine|propose_routine_action)$/, "setting up a routine"],
  [/^(propose_profile|propose_model)$/, "drafting a change"],
  [/^(create_room|manage_room)$/, "setting up a group chat"],
  [/^add_mcp_server$/, "adding an app"],
  [/^attach_file$/, "attaching a file"],
  [/^send_voice_note$/, "recording a voice note"],
  [/^create_options_card$/, "putting options together"],
  [/^tool_result_read$/, "reading the results"],
  [SHELL_TOOL, "running a few commands"],
  [/^(read|read_file|view|notebookread)$/, "doing some reading"],
  [/^(write|create_file|edit|multiedit|apply_patch|str_replace|str_replace_based_edit_tool|notebookedit)$/, "making edits"],
  [/^(grep|glob|find|search|ls|list_files)$/, "sniffing around"],
  [/^(web_?search|websearch|search_web)$/, "sniffing around the web"],
  [/^(web_?fetch|fetch|fetch_url|read_page)$/, "reading a page"],
  [/^(screenshot|screen_capture|computer_screenshot)$/, "looking at the screen"],
  [/^(click|double_click|type_text|press_key|key|scroll|drag|computer|computer_batch|computer_use)$/, "clicking around"],
  [/^(open_url|navigate|browser_navigate)$/, "opening a page"],
  [/^browser_/, "clicking around"],
  [/^(todowrite|todo_write|update_plan)$/, "making a plan"],
  [/^(task|agent|spawn_agent)$/, "getting some help"],
];

function clipName(name: string): string {
  const flat = name.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

function names(value: unknown, nameOf: NameOf): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => nameOf(item.trim()))
    .filter((name): name is string => Boolean(name))
    .map(clipName);
}

function checkingWith(found: string[]): string {
  if (found.length === 1) return `checking with ${found[0]}`;
  if (found.length === 2) return `checking with ${found[0]} and ${found[1]}`;
  return found.length > 2 ? `checking with ${found.length} dogs` : "checking with a teammate";
}

function record(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const OWN_SERVERS = new Set(["agents", "computer", "laterdog", "browser", "dog", "shell", "team-notes", "memory"]);

function serviceName(server: string, tool: string): string | null {
  if (OWN_SERVERS.has(server)) return null;
  const raw = server === "composio" ? tool.split("_", 1)[0]! : server.replace(/^claude_ai_/, "");
  const words = raw.replace(/[-_]+/g, " ").trim();
  if (!words) return null;
  return words.split(" ").map((word) => (word === word.toUpperCase() ? word[0]! + word.slice(1).toLowerCase() : word[0]!.toUpperCase() + word.slice(1))).join(" ");
}

export function dogActivityWords(toolName: string, input: unknown, nameOf: NameOf, command = false): string | null {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName.trim());
  const name = (mcp ? mcp[2]! : toolName).split(":", 1)[0]!.trim();
  if (!name || /^(auto-approved|error)$/i.test(name)) return null;
  const bare = name.toLowerCase();
  const team = TEAM_TOOLS[bare];
  if (team) return team(record(input), nameOf);
  const service = mcp ? serviceName(mcp[1]!, name) : null;
  if (service) return `working in ${service}`;
  if (SHELL_TOOL.test(bare)) return describedCommand(input) ?? "running a few commands";
  for (const [pattern, phrase] of PHRASES) if (pattern.test(bare)) return phrase;
  return command ? "running a few commands" : "working on it";
}

export function botNames(store: Pick<Store, "bot" | "bots">): NameOf {
  return (idOrName) => {
    const lower = idOrName.toLowerCase();
    return store.bot(idOrName)?.name ?? store.bots.find((bot) => bot.name.trim().toLowerCase() === lower)?.name;
  };
}

export function teammateResultLabel(name: string, status: string, withheld: string | null | undefined, room?: string, end?: HandoffEnd): string {
  if (withheld) return `${name}'s reply was held back`;
  if (status === "completed") return room ? `${name} replied · ${room}` : `${name} replied`;
  return teammateEndLabel(name, status, end);
}
