export const ACTIVITY_SCRIPT = String.raw`import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";

const OUT = homedir() + "/task/activity.jsonl";
const WORK = homedir() + "/work/";
const SECRETS = [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.GH_TOKEN].filter((value) => typeof value === "string" && value.length >= 8);
process.on("uncaughtException", () => {});

function clean(value) {
  let out = typeof value === "string" ? value : value == null ? "" : String(value);
  for (const secret of SECRETS) out = out.split(secret).join("[redacted]");
  return out;
}
function clip(value, max) {
  const out = clean(value).trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}
function firstLine(value, max) {
  const lines = clean(value).split("\n").map((line) => line.trim()).filter(Boolean);
  return clip(lines[0] ?? "", max);
}
function relative(path) {
  const out = typeof path === "string" ? path : "";
  return out.startsWith(WORK) ? out.slice(WORK.length) : out;
}
function emit(step) {
  try { appendFileSync(OUT, JSON.stringify({ t: Date.now(), ...step }) + "\n"); } catch {}
}
function detail(name, input) {
  const args = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Bash": return firstLine(args.command, 300);
    case "Read": case "Edit": case "MultiEdit": case "Write": return clip(relative(args.file_path), 300);
    case "NotebookEdit": return clip(relative(args.notebook_path), 300);
    case "Grep": return clip((args.pattern ?? "") + (args.path ? " in " + relative(args.path) : ""), 300);
    case "Glob": return clip(args.pattern, 300);
    case "WebFetch": return clip(args.url, 300);
    case "WebSearch": return clip(args.query, 300);
    case "Task": case "Agent": return clip(args.description ?? args.prompt, 300);
    default: try { return clip(JSON.stringify(args), 200); } catch { return ""; }
  }
}
function resultText(content) {
  if (Array.isArray(content)) return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join(" ");
  return typeof content === "string" ? content : "";
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;
  if (event.type === "assistant" && !event.parent_tool_use_id) {
    for (const block of event.message?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) emit({ k: "say", text: clip(block.text, 4000) });
      else if (block?.type === "tool_use") {
        if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
          emit({ k: "plan", todos: block.input.todos.slice(0, 50).map((todo) => ({ text: clip(todo?.content ?? todo?.activeForm ?? "", 300), status: todo?.status })) });
        } else {
          emit({ k: "tool", tool: String(block.name ?? "tool").slice(0, 80), detail: detail(block.name, block.input) });
        }
      }
    }
  } else if (event.type === "user" && !event.parent_tool_use_id) {
    for (const block of event.message?.content ?? []) {
      if (block?.type === "tool_result" && block.is_error) {
        const said = firstLine(resultText(block.content), 300);
        if (said) emit({ k: "error", text: said });
      }
    }
  } else if (event.type === "result") {
    emit({ k: "done", ok: !event.is_error, text: clip(event.result ?? "", 4000), turns: event.num_turns, ms: event.duration_ms });
  }
});
`;

export const WATCH_SCRIPT = String.raw`import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";

const FILE = homedir() + "/task/activity.jsonl";
const STAGES = { starting: "Starting its computer", install: "Installing Claude Code", clone: "Getting the code", setup: "Setting up the project", claude: "Working", done: "Wrapping up" };
const paint = (code, value) => "\x1b[" + code + "m" + value + "\x1b[0m";
let position = 0;
let rest = "";

process.stdout.write("\x1b]0;later.dog cloud task\x07");
console.log(paint("1", "later.dog cloud task") + paint("2", "  live progress"));

function show(step) {
  switch (step.k) {
    case "stage": console.log("\n" + paint("1;36", "▸ " + (STAGES[step.stage] ?? step.stage))); break;
    case "say": console.log("\n" + step.text); break;
    case "tool": console.log(paint("2", "  › " + step.tool + (step.detail ? "  " + step.detail : ""))); break;
    case "plan": console.log(paint("2", "  plan\n") + step.todos.map((todo) => "    " + (todo.status === "completed" ? "✓ " : todo.status === "in_progress" ? "→ " : "· ") + todo.text).join("\n")); break;
    case "error": console.log(paint("33", "  ! " + step.text)); break;
    case "done": console.log("\n" + paint(step.ok ? "1;32" : "1;31", step.ok ? "✓ Done" : "✗ Stopped") + (step.text ? "\n" + step.text : "")); break;
  }
}
function tick() {
  try {
    if (!existsSync(FILE)) return;
    const size = statSync(FILE).size;
    if (size <= position) return;
    const handle = openSync(FILE, "r");
    const buffer = Buffer.alloc(size - position);
    readSync(handle, buffer, 0, buffer.length, position);
    closeSync(handle);
    position = size;
    const lines = (rest + buffer.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) { try { show(JSON.parse(line)); } catch {} }
  } catch {}
}
setInterval(tick, 700);
tick();
`;

export const AUTO_SETUP_SCRIPT = String.raw`set -uo pipefail
status=0
run() { printf '+ %s\n' "$*"; "$@"; }
if [ -f pnpm-lock.yaml ]; then
  sudo corepack enable >/dev/null 2>&1 || true
  run pnpm install --frozen-lockfile || status=$?
elif [ -f yarn.lock ]; then
  sudo corepack enable >/dev/null 2>&1 || true
  run yarn install --frozen-lockfile || run yarn install --immutable || status=$?
elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
  run npm ci || status=$?
elif [ -f package.json ]; then
  run npm install || status=$?
fi
if [ -f requirements.txt ]; then
  run python3 -m pip install --user --break-system-packages -r requirements.txt || status=$?
fi
exit $status
`;

export const SETUP_FAILED_NOTE = "\n\nNote from later.dog: installing this project's dependencies failed during setup (the output is in ~/task/log). Install what you need before running checks.\n";
