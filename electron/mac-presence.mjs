import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const PRESENCE_LINGER_MS = 2000;
const CURSOR_WAIT_MS = 1500;
const UNNAMED = "My Cloud";
const NAMES_KEPT = 50;

const SCREEN_WORDS = {
  click: "clicking", double_click: "double-clicking", right_click: "right-clicking", drag: "dragging", scroll: "scrolling",
  move_cursor: "moving the pointer", hotkey: "pressing keys", press_key: "pressing a key", type_text: "typing", set_value: "typing",
  bring_to_front: "bringing a window forward", list_apps: "looking at open apps", list_windows: "looking at open windows",
  get_window_state: "looking at the screen", get_accessibility_tree: "looking at the screen", get_desktop_state: "looking at the screen",
  get_screen_size: "looking at the screen", get_cursor_position: "looking at the screen", zoom: "looking closer at the screen",
  browser_click: "clicking in the browser", browser_type: "typing in the browser", browser_navigate: "opening a page in the browser",
  browser_pointer: "pointing in the browser", browser_dialog: "answering a page's dialog", get_browser_state: "reading a page in the browser",
};
const IN_APP = new Set(["click", "double_click", "right_click", "drag", "scroll", "hotkey", "press_key", "type_text", "set_value", "bring_to_front"]);
const FILE_WORDS = {
  list_files: "looking through files", read_file: "reading files", write_file: "writing files",
  edit_file: "editing files", delete_file: "deleting files", search_files: "searching files",
};
const COMMAND_WORDS = { command_output: "checking on a command", command_input: "typing into a command", command_stop: "stopping a command" };

// oxlint-disable-next-line no-control-regex
const plain = (value, max) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

function homeWay(dir, home) {
  if (dir.startsWith("~") || !path.isAbsolute(dir)) return dir;
  const inside = path.relative(home, dir);
  if (!inside) return "~";
  return inside.startsWith("..") || path.isAbsolute(inside) ? dir : `~/${inside}`;
}

function filePlace(grant, operation) {
  const given = plain(operation.path, 300).replace(/^\/+|\/+$/g, "");
  const folderPath = operation.action === "list_files" || operation.action === "search_files";
  const parent = path.posix.dirname(given);
  const dir = folderPath ? given : parent === "." ? "" : parent;
  if (grant?.home === true) return dir || "your home folder";
  const folder = grant?.folders?.find?.(entry => entry.id === operation.folder_id);
  const name = plain(folder?.name, 60) || "a shared folder";
  return dir ? `${name}/${dir}` : name;
}

export function presenceStep(operation, grant, { app = "", home = os.homedir() } = {}) {
  const action = operation?.action;
  if (Object.hasOwn(FILE_WORDS, action)) return `${FILE_WORDS[action]} in ${filePlace(grant, operation)}`;
  if (action === "run_command") {
    const cwd = plain(operation.cwd, 200);
    return cwd ? `running a command in ${homeWay(cwd, home)}` : "running a command";
  }
  if (Object.hasOwn(COMMAND_WORDS, action)) return COMMAND_WORDS[action];
  if (action === "computer_tools") return "getting ready to use apps";
  if (action !== "computer_call") return "working";
  const tool = operation.tool_name;
  const given = operation.arguments ?? {};
  if (tool === "launch_app") {
    const name = plain(given.name, 60) || plain(String(given.bundle_id ?? "").split(".").at(-1), 60);
    return name ? `opening ${name}` : "opening an app";
  }
  const appName = plain(app, 60);
  if (appName && tool === "get_window_state") return `looking at ${appName}`;
  const words = Object.hasOwn(SCREEN_WORDS, tool) ? SCREEN_WORDS[tool] : "using apps";
  return appName && IN_APP.has(tool) ? `${words} in ${appName}` : words;
}

export function presencePoint(operation) {
  const given = operation?.action === "computer_call" ? operation.arguments ?? {} : {};
  if (given.pid !== undefined || given.window_id !== undefined) return null;
  return Number.isFinite(given.x) && Number.isFinite(given.y) ? { x: given.x, y: given.y } : null;
}

export function appNameForPid(pid, { run = execFile } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve("");
  return new Promise(resolve => {
    run("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 1000, encoding: "utf8" }, (error, stdout) => {
      if (error) return resolve("");
      const command = String(stdout ?? "").trim();
      const bundle = /\/([^/]+)\.app(?:\/|$)/.exec(command);
      resolve(plain(bundle ? bundle[1] : path.basename(command), 60));
    });
  });
}

const within = (work, ms) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  Promise.resolve().then(work).catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
});

export function createMacPresence({
  shown = () => true, render = () => {}, describe = () => {}, appName = appNameForPid,
  lingerMs = PRESENCE_LINGER_MS, cursorWaitMs = CURSOR_WAIT_MS, home = os.homedir(),
} = {}) {
  const active = new Map();
  const cursors = new Map();
  const names = new Map();
  let drawn = false;
  let fade = null;
  const tell = (target, state) => { try { target(state); } catch {} };
  const stateOf = entry => ({
    name: entry.name,
    step: presenceStep(entry.operation, entry.grant, { app: entry.app, home }),
    screen: [...active.values()].some(job => job.screen),
    point: entry.point,
  });
  const refresh = () => {
    const entry = [...active.values()].at(-1);
    if (!entry) return;
    const state = stateOf(entry);
    tell(describe, state);
    if (shown()) { drawn = true; tell(render, state); }
    else if (drawn) { drawn = false; tell(render, null); }
  };
  const cursorsOff = () => {
    const turning = [...cursors];
    cursors.clear();
    for (const [session, cursor] of turning) void within(() => cursor(false, session), cursorWaitMs);
  };
  const finish = () => {
    clearTimeout(fade);
    fade = null;
    if (drawn) { drawn = false; tell(render, null); }
    tell(describe, null);
    cursorsOff();
  };
  const learnApp = (pid, entry) => {
    if (!Number.isSafeInteger(pid) || names.has(pid)) return;
    if (names.size >= NAMES_KEPT) names.clear();
    names.set(pid, "");
    void Promise.resolve().then(() => appName(pid)).catch(() => "").then(name => {
      names.set(pid, name ?? "");
      if (name && active.has(entry.id) && [...active.values()].at(-1) === entry) { entry.app = name; refresh(); }
    });
  };
  return {
    begin({ id, by, operation, grant, cursor }) {
      clearTimeout(fade);
      fade = null;
      const screen = operation?.action === "computer_call";
      const pid = screen ? operation.arguments?.pid : undefined;
      const entry = { id, name: plain(by, 60) || UNNAMED, operation, grant, screen, app: names.get(pid) ?? "", point: presencePoint(operation) };
      active.delete(id);
      active.set(id, entry);
      refresh();
      if (screen) learnApp(pid, entry);
      if (!screen || typeof cursor !== "function" || !shown()) return Promise.resolve();
      const session = typeof operation.arguments?.session === "string" ? operation.arguments.session : "";
      if (cursors.has(session)) return Promise.resolve();
      cursors.set(session, cursor);
      return within(() => cursor(true, session), cursorWaitMs);
    },
    end(id) {
      if (!active.delete(id)) return;
      if (active.size) return refresh();
      clearTimeout(fade);
      fade = setTimeout(finish, lingerMs);
      fade.unref?.();
    },
    shownChanged() {
      if (shown()) return refresh();
      if (drawn) { drawn = false; tell(render, null); }
      cursorsOff();
    },
    stop() {
      active.clear();
      finish();
    },
  };
}
