export interface ToolPhrase {
  done: string;
  running: string;
}

export const USED_A_TOOL: ToolPhrase = { done: "Used a tool", running: "Using a tool" };

const PHRASES: ReadonlyArray<[RegExp, ToolPhrase]> = [
  [/^(?:run_on_computer|computer_exec|vm_exec)$/, { done: "Ran a command on its computer", running: "Running a command on its computer" }],
  [/^(?:bash|shell|terminal|run_command|execute|exec_command|exec|local_shell|mac_run_command)$/, { done: "Ran a command", running: "Running a command" }],
  [/^(?:bashoutput|bash_output|command_output|write_stdin|command_input)$/, { done: "Checked command output", running: "Checking command output" }],
  [/^(?:killshell|kill_shell|killbash|kill_bash|command_stop)$/, { done: "Stopped a command", running: "Stopping a command" }],
  [/^(?:read|read_file|view|notebookread|open_file|tool_result_read|mac_read_file)$/, { done: "Read a file", running: "Reading a file" }],
  [/^(?:write|create_file|write_file|mac_write_file)$/, { done: "Wrote a file", running: "Writing a file" }],
  [/^(?:edit|multiedit|apply_patch|str_replace|str_replace_editor|str_replace_based_edit_tool|notebookedit|edit_file)$/, { done: "Edited a file", running: "Editing a file" }],
  [/^(?:grep|glob|find|ls|list_files|search_files|mac_list_files)$/, { done: "Searched the files", running: "Searching the files" }],
  [/^(?:web_?search|search_web)$/, { done: "Searched the web", running: "Searching the web" }],
  [/^(?:web_?fetch|fetch|fetch_url|read_page)$/, { done: "Read a page", running: "Reading a page" }],
  [/^(?:open_url|navigate|browser_navigate)$/, { done: "Opened a page", running: "Opening a page" }],
  [/^(?:screenshot|screen_capture|computer_screenshot|browser_screenshot)$/, { done: "Looked at the screen", running: "Looking at the screen" }],
  [/^(?:click|double_click|right_click|type_text|press_key|key|key_press|hotkey|scroll|drag|move|computer|computer_use|computer_call|mac_computer_call|browser_.+)$/, { done: "Used the computer", running: "Using the computer" }],
  [/^(?:shared_computer|select_computer)$/, { done: "Used a computer", running: "Using a computer" }],
  [/^(?:coordinate_bots|ask_bot|delegate_bot|send_message)$/, { done: "Asked other dogs", running: "Asking other dogs" }],
  [/^(?:list_bots|list_agents|listagents)$/, { done: "Checked who's around", running: "Checking who's around" }],
  [/^(?:post_to_room|create_room|manage_room|list_rooms)$/, { done: "Worked in a group", running: "Working in a group" }],
  [/^(?:create_bot)$/, { done: "Made a new dog", running: "Making a new dog" }],
  [/^(?:start_tasks)$/, { done: "Started tasks", running: "Starting tasks" }],
  [/^(?:memory_update|memory_log)$/, { done: "Made a note", running: "Making a note" }],
  [/^(?:session_search|session_read)$/, { done: "Looked back through chats", running: "Looking back through chats" }],
  [/^(?:todowrite|todo_write|update_plan|set_plan)$/, { done: "Updated the plan", running: "Updating the plan" }],
  [/^(?:task|agent|spawn_agent)$/, { done: "Got some help", running: "Getting some help" }],
  [/^(?:toolsearch|tool_search)$/, { done: "Looked for a tool", running: "Looking for a tool" }],
  [/^(?:read_phone|add_to_phone|change_on_phone)$/, { done: "Used your iPhone", running: "Using your iPhone" }],
  [/^(?:send_text|mac_send_text)$/, { done: "Sent a text", running: "Sending a text" }],
  [/^(?:send_email|mac_send_email)$/, { done: "Sent an email", running: "Sending an email" }],
];

const NAMED = /^(?:Bash|BashOutput|KillShell|KillBash|Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead|Grep|Glob|LS|WebSearch|WebFetch|TodoWrite|Task|Agent|ToolSearch|ListAgents|Skill|SlashCommand|ExitPlanMode|EnterPlanMode|AskUserQuestion)$/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const JOINED = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){2,}$/;

export function bareToolName(name: string): string {
  return name.trim().toLowerCase().replace(/^functions\./, "").replace(/^(?:mcp__.+?|[a-z][a-z0-9_-]{0,31})__/, "").split(":", 1)[0]!.trim();
}

export function toolPhrase(name: string): ToolPhrase {
  const bare = bareToolName(name);
  return PHRASES.find(([pattern]) => pattern.test(bare))?.[1] ?? USED_A_TOOL;
}

function knownTool(head: string): boolean {
  return /^\S+$/.test(head) && PHRASES.some(([pattern]) => pattern.test(bareToolName(head)));
}

function looksLikeToolName(text: string): boolean {
  const word = text.trim();
  if (!/^\S+$/.test(word)) return false;
  return word.includes("__") || /^functions\.\w+$/.test(word) || NAMED.test(word) || SNAKE.test(word) || JOINED.test(word);
}

export function plainToolLabel(label: string, running: boolean): string {
  const text = label.trim();
  const split = /^([^\s:]+):\s*(.*)$/s.exec(text);
  const head = split?.[1] ?? text;
  if (!knownTool(head) && !looksLikeToolName(head)) return withoutInternalNames(text, running);
  const phrase = toolPhrase(head);
  const said = running ? phrase.running : phrase.done;
  const detail = split?.[2]?.trim();
  return detail && !INTERNAL.test(detail) ? `${said}: ${detail}` : said;
}

const INTERNAL = /\S*__\S*|\bfunctions\.\w+/;
const INTERNAL_ALL = /\S*__\S*|\bfunctions\.\w+/g;

function withoutInternalNames(text: string, running: boolean): string {
  if (!INTERNAL.test(text)) return text;
  const plain = text.replace(INTERNAL_ALL, "a tool").replace(/\s+/g, " ").trim();
  if (!plain || /^a tool[.:]?$/i.test(plain)) return running ? USED_A_TOOL.running : USED_A_TOOL.done;
  return `${plain[0]!.toUpperCase()}${plain.slice(1)}`;
}
