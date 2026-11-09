import { appendFileSync, chownSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const HOME_HEALTH_FILE = "home-health.log";
const TAIL_BYTES = 4096;
const SAID_ERROR_CHARS = 600;

export function outputTail(limit = TAIL_BYTES) {
  let tail = "";
  return {
    push(chunk) { tail = (tail + String(chunk)).slice(-limit); },
    text() { return tail; },
    clear() { tail = ""; },
  };
}

export function lastError(tail) {
  const lines = String(tail ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /^(?:\w+Error|Error)\b|^error\b/i.test(line) || /\b\w*Error: /.test(line));
  const said = errorLine ?? lines.slice(-6).join(" | ");
  return said.length > SAID_ERROR_CHARS ? `…${said.slice(-SAID_ERROR_CHARS)}` : said;
}

export function pushedCodeFellBack({ code, signal, tail }) {
  const error = lastError(tail);
  return `the pushed server code stopped right away (exit code ${code ?? "none"}, signal ${signal ?? "none"}); this home now runs the image's own server, so the pushed changes are not live${error ? `. Last output: ${error}` : ""}`;
}

export function noteHomeHealth(dir, message, { owner, now = new Date() } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, HOME_HEALTH_FILE);
    const existed = existsSync(file);
    appendFileSync(file, `${now.toISOString()} cloud home: ${message}\n`);
    if (!existed && owner) chownSync(file, owner.uid, owner.gid);
    return true;
  } catch {
    return false;
  }
}
