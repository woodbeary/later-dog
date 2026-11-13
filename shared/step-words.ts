export type NameOf = (idOrName: string) => string | undefined;

export interface StepWords {
  now: string;
  done: string;
}

const words = (now: string, done: string): StepWords => ({ now, done });

type Input = Record<string, unknown>;

const TEAM_TOOLS: Record<string, (input: Input, nameOf: NameOf) => StepWords> = {
  coordinate_bots: (input, nameOf) => checkingWith(names(input.bot_ids, nameOf)),
  create_bot: (input) => (typeof input.name === "string" && input.name.trim() ? words(`making ${clipName(input.name)}`, `made ${clipName(input.name)}`) : words("making a new dog", "made a new dog")),
  shared_computer: (input) => onTheMac(input),
  read_phone: (input) => onThePhone(input),
  add_to_phone: (input) => onThePhone(input),
  change_on_phone: (input) => changingOnThePhone(input),
  nearby_places: (input) => (typeof input.what === "string" && input.what.trim()
    ? words(`looking for ${clipName(input.what.trim())} nearby`, `looked for ${clipName(input.what.trim())} nearby`)
    : words("looking for places nearby", "looked for places nearby")),
  start_tasks: (input) => startingTasks(input),
  send_text: () => words("sending a text", "sent a text"),
  read_texts: (input) => (typeof input.with === "string" && input.with.trim()
    ? words(`reading texts with ${clipName(input.with)}`, `read texts with ${clipName(input.with)}`)
    : words("reading your texts", "read your texts")),
  send_email: () => words("sending an email", "sent an email"),
};

function startingTasks(input: Input): StepWords {
  const count = Array.isArray(input.tasks) ? input.tasks.length : 0;
  return count > 1 ? words(`starting ${count} tasks`, `started ${count} tasks`) : words("starting a task", "started a task");
}

function fileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = value.trim().replace(/\/+$/, "").split("/").pop();
  return base ? clipName(base) : null;
}

function commandName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.replace(/^\s*(export\s+\S+\s*;\s*|cd\s+\S+\s*(&&|;)\s*)+/, "").trim().split(/\s+/);
  const head = parts[0] === "pnpm" && parts[1] === "exec" ? parts[2] : parts[0] === "git" || parts[0] === "pnpm" ? `${parts[0]} ${parts[1] ?? ""}`.trim() : parts[0];
  return head ? clipName(head.split("/").pop()!) : null;
}

function onThePhone(input: Input): StepWords {
  switch (input.what) {
    case "calendar": return words("checking your calendar", "checked your calendar");
    case "reminders": return words("checking your reminders", "checked your reminders");
    case "contacts": return typeof input.query === "string" && input.query.trim()
      ? words(`looking up ${clipName(input.query.trim())}`, `looked up ${clipName(input.query.trim())}`)
      : words("looking through your contacts", "looked through your contacts");
    case "location": return words("checking where you are", "checked where you are");
    case "calendar_event": return words("adding to your calendar", "added to your calendar");
    case "reminder": return words("adding a reminder", "added a reminder");
    default: return words("using your iPhone", "used your iPhone");
  }
}

function changingOnThePhone(input: Input): StepWords {
  if (input.what === "reminder") return input.completed === true ? words("ticking off a reminder", "ticked off a reminder") : words("updating a reminder", "updated a reminder");
  return input.what === "calendar_event" ? words("changing an event on your calendar", "changed an event on your calendar") : words("using your iPhone", "used your iPhone");
}

function onTheMac(input: Input): StepWords {
  const file = fileName(input.path);
  switch (input.action) {
    case "run_command": {
      const name = commandName(input.command);
      return name ? words(`running ${name} on your Mac`, `ran ${name} on your Mac`) : words("running a command on your Mac", "ran a command on your Mac");
    }
    case "command_output": case "command_input": return words("checking a command on your Mac", "checked a command on your Mac");
    case "command_stop": return words("stopping a command on your Mac", "stopped a command on your Mac");
    case "read_file": return file ? words(`reading ${file} on your Mac`, `read ${file} on your Mac`) : words("reading a file on your Mac", "read a file on your Mac");
    case "write_file": case "edit_file": return file ? words(`editing ${file} on your Mac`, `edited ${file} on your Mac`) : words("editing a file on your Mac", "edited a file on your Mac");
    case "delete_file": return file ? words(`deleting ${file} on your Mac`, `deleted ${file} on your Mac`) : words("deleting a file on your Mac", "deleted a file on your Mac");
    case "list_files": case "search_files": return words("looking through files on your Mac", "looked through files on your Mac");
    case "computer_tools": case "computer_call": return words("using your Mac's screen", "used your Mac's screen");
    default: return words("using your Mac", "used your Mac");
  }
}

export const SHELL_TOOL = /^(bash|shell|terminal|run_command|execute|exec_command|computer_exec|vm_exec|local_shell)$/;
const DESCRIPTION_CHARS = 60;
const RAN_A_COMMAND = "ran a command";

function describedCommand(input: unknown): string | null {
  const fields = record(input);
  for (const field of [fields.description, fields.justification]) {
    if (typeof field !== "string") continue;
    const flat = field.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const clipped = flat.length > DESCRIPTION_CHARS ? `${flat.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : flat;
    return /^[A-Z][^A-Z]/.test(clipped) || /^[A-Z]$/.test(clipped) ? `${clipped[0]!.toLowerCase()}${clipped.slice(1)}` : clipped;
  }
  return null;
}

const PHRASES: Array<[RegExp, StepWords]> = [
  [/^delegate_cloud_job$/, words("starting a cloud task", "started a cloud task")],
  [/^(inspect_cloud_job|review_cloud_job|collect_cloud_diff|reconcile_cloud_task|list_provider_tasks|record_job_observation)$/, words("checking on a cloud task", "checked on a cloud task")],
  [/^correct_cloud_job$/, words("sending a fix to a cloud task", "sent a fix to a cloud task")],
  [/^list_bots$/, words("checking who's around", "checked who's around")],
  [/^account_usage$/, words("checking usage", "checked usage")],
  [/^switch_account$/, words("switching accounts", "switched accounts")],
  [/^dog_accounts$/, words("checking dogs' accounts", "checked dogs' accounts")],
  [/^dog_queue$/, words("managing a teammate's work", "managed a teammate's work")],
  [/^(request_credential|request_takeover|request_secure_form)$/, words("needs your input", "asked for your input")],
  [/^fill_secure_field$/, words("signing in", "signed in")],
  [/^(select_computer|list_shared_computers)$/, words("picking a computer", "picked a computer")],
  [/^(memory_update|memory_log)$/, words("making a note", "made a note")],
  [/^(session_search|session_read)$/, words("looking back through chats", "looked back through chats")],
  [/^(skills_list|skill_manage)$/, words("learning a trick", "learned a trick")],
  [/^list_routines$/, words("checking routines", "checked routines")],
  [/^(propose_routine|propose_routine_action)$/, words("setting up a routine", "set up a routine")],
  [/^(propose_profile|propose_model)$/, words("drafting a change", "drafted a change")],
  [/^(create_room|manage_room)$/, words("setting up a group chat", "set up a group chat")],
  [/^add_mcp_server$/, words("adding an app", "added an app")],
  [/^attach_file$/, words("attaching a file", "attached a file")],
  [/^send_voice_note$/, words("recording a voice note", "recorded a voice note")],
  [/^react$/, words("reacting", "reacted")],
  [/^create_options_card$/, words("putting options together", "put options together")],
  [/^tool_result_read$/, words("reading the results", "read the results")],
  [SHELL_TOOL, words("running a few commands", RAN_A_COMMAND)],
  [/^(read|read_file|view|notebookread)$/, words("doing some reading", "did some reading")],
  [/^(write|create_file|edit|multiedit|apply_patch|str_replace|str_replace_based_edit_tool|notebookedit)$/, words("making edits", "made edits")],
  [/^(grep|glob|find|search|ls|list_files)$/, words("sniffing around", "sniffed around")],
  [/^(web_?search|websearch|search_web)$/, words("sniffing around the web", "searched the web")],
  [/^(web_?fetch|fetch|fetch_url|read_page)$/, words("reading a page", "read a page")],
  [/^(screenshot|screen_capture|computer_screenshot)$/, words("looking at the screen", "looked at the screen")],
  [/^(click|double_click|type_text|press_key|key|scroll|drag|computer|computer_batch|computer_use)$/, words("clicking around", "clicked around")],
  [/^(open_url|navigate|browser_navigate)$/, words("opening a page", "opened a page")],
  [/^browser_/, words("clicking around", "clicked around")],
  [/^(todowrite|todo_write|update_plan|set_plan)$/, words("making a plan", "made a plan")],
  [/^(task|agent|spawn_agent)$/, words("getting some help", "asked a helper")],
];

export const COMMAND_WORDS = words("running a command", RAN_A_COMMAND);
export const FILE_CHANGE_WORDS = words("changing files", "changed files");
export const UNKNOWN_STEP_WORDS = words("doing a step", "did a step");

export function clipName(name: string): string {
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

function checkingWith(found: string[]): StepWords {
  if (found.length === 1) return words(`checking with ${found[0]}`, `checked with ${found[0]}`);
  if (found.length === 2) return words(`checking with ${found[0]} and ${found[1]}`, `checked with ${found[0]} and ${found[1]}`);
  return found.length > 2 ? words(`checking with ${found.length} dogs`, `checked with ${found.length} dogs`) : words("checking with a teammate", "checked with a teammate");
}

function record(input: unknown): Input {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Input : {};
}

const OWN_SERVERS = new Set(["agents", "computer", "laterdog", "browser", "dog", "shell", "team-notes", "memory"]);

function serviceName(server: string, tool: string): string | null {
  if (OWN_SERVERS.has(server)) return null;
  const raw = server === "composio" ? tool.split("_", 1)[0]! : server.replace(/^claude_ai_/, "");
  const spaced = raw.replace(/[-_]+/g, " ").trim();
  if (!spaced) return null;
  return spaced.split(" ").map((word) => (word === word.toUpperCase() ? word[0]! + word.slice(1).toLowerCase() : word[0]!.toUpperCase() + word.slice(1))).join(" ");
}

export function bareToolName(toolName: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName.trim());
  return (mcp ? mcp[2]! : toolName).split(":", 1)[0]!.trim();
}

const nobody: NameOf = () => undefined;

export function toolStepWords(toolName: string, input: unknown, nameOf: NameOf = nobody): StepWords | null {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName.trim());
  const name = bareToolName(toolName);
  if (!name) return null;
  const bare = name.toLowerCase();
  const team = TEAM_TOOLS[bare];
  if (team) return team(record(input), nameOf);
  const service = mcp ? serviceName(mcp[1]!, name) : null;
  if (service) return words(`working in ${service}`, `worked in ${service}`);
  if (SHELL_TOOL.test(bare)) return words(describedCommand(input) ?? "running a few commands", RAN_A_COMMAND);
  for (const [pattern, phrase] of PHRASES) if (pattern.test(bare)) return phrase;
  return null;
}
