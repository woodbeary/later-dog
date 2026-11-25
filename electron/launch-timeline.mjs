import fs from "node:fs";
import path from "node:path";

export const LAUNCH_TIMELINE_ENV = "LATERDOG_LAUNCH_TIMELINE";
export const LAUNCH_TIMELINE_CHANNEL = "launch-timeline:mark";
export const LAUNCH_TIMELINE_ARGUMENT = "--laterdog-launch-timeline=1";
export const LAUNCH_TIMELINE_DONE = "renderer-message-box-ready";
export const RENDERER_MARKS = Object.freeze([
  "renderer-started",
  "renderer-first-paint",
  "renderer-root-filled",
  "renderer-launch-splash-shown",
  "renderer-launch-splash-leaving",
  LAUNCH_TIMELINE_DONE,
]);
const MAX_MARKS = 200;

const nothing = () => {};
const DISABLED = Object.freeze({
  enabled: false,
  mark: nothing,
  receive: nothing,
  watchWindow: nothing,
  listen: nothing,
  finish: () => false,
  rendererArguments: () => [],
});

const epochNow = () => performance.timeOrigin + performance.now();

function writeAtomically(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, text);
  fs.renameSync(partial, file);
}

const cleanDetail = (detail) => {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const kept = {};
  for (const [key, value] of Object.entries(detail).slice(0, 8)) {
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) kept[key] = value;
    else if (typeof value === "string") kept[key] = value.slice(0, 200);
  }
  return Object.keys(kept).length ? kept : undefined;
};

export function createLaunchTimeline({
  env = process.env,
  now = epochNow,
  processStart = performance.timeOrigin,
  write = writeAtomically,
  facts = () => ({}),
} = {}) {
  const file = typeof env[LAUNCH_TIMELINE_ENV] === "string" ? env[LAUNCH_TIMELINE_ENV].trim() : "";
  if (!file) return DISABLED;
  const marks = [{ name: "main-process-start", at: processStart }];
  const seen = new Set(["main-process-start"]);
  let written = false;
  let watchedWindow = null;

  const record = (name, at, detail) => {
    if (written || seen.has(name) || marks.length >= MAX_MARKS) return;
    seen.add(name);
    const entry = { name, at };
    const kept = cleanDetail(detail);
    if (kept) entry.detail = kept;
    marks.push(entry);
  };

  const finish = (outcome = "complete") => {
    if (written) return false;
    written = true;
    const ordered = [...marks].sort((a, b) => a.at - b.at);
    const report = {
      version: 1,
      outcome,
      pid: process.pid,
      platform: process.platform,
      ...facts(),
      processStart,
      marks: ordered.map((entry) => ({ ...entry, sinceStartMs: Math.round((entry.at - processStart) * 10) / 10 })),
    };
    write(file, `${JSON.stringify(report, null, 2)}\n`);
    return true;
  };

  const mark = (name, detail) => record(name, now(), detail);

  const receive = (name, at, detail) => {
    if (!RENDERER_MARKS.includes(name)) return;
    const time = typeof at === "number" && Number.isFinite(at) ? at : now();
    record(name, time, detail);
    record(`${name}-received`, now());
    if (name === LAUNCH_TIMELINE_DONE) finish("complete");
  };

  const watchWindow = (win) => {
    if (watchedWindow) return;
    watchedWindow = win;
    win.once("ready-to-show", () => mark("window-ready-to-show"));
    win.once("show", () => mark("window-shown"));
    win.webContents.once("did-finish-load", () => mark("window-did-finish-load"));
  };

  const listen = (ipcMain) => {
    ipcMain.on(LAUNCH_TIMELINE_CHANNEL, (event, name, at, detail) => {
      if (!watchedWindow || watchedWindow.isDestroyed() || event.sender !== watchedWindow.webContents) return;
      receive(name, at, detail);
    });
  };

  return {
    enabled: true,
    mark,
    receive,
    watchWindow,
    listen,
    finish,
    rendererArguments: () => [LAUNCH_TIMELINE_ARGUMENT],
  };
}
