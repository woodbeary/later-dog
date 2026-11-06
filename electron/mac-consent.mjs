import { execFile } from "node:child_process";

export const CONSENT_OWNERS = Object.freeze([
  "UserNotificationCenter", "universalAccessAuthWarn", "SecurityAgent", "CoreServicesUIAgent", "tccd", "ScreenCaptureUI",
]);
const CHECKED_ACTIONS = new Set(["run_command", "command_output", "computer_tools", "computer_call"]);

const WINDOW_SCRIPT = `ObjC.import('CoreGraphics');
function run() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)).js;
  return list.map(w => { const d = w.js; return (d.kCGWindowOwnerName ? d.kCGWindowOwnerName.js : "") + "\\t" + d.kCGWindowLayer.js; }).join("\\n");
}`;

export function parseWindowOwners(stdout) {
  return String(stdout ?? "").split("\n").map(line => line.split("\t")).filter(([owner]) => owner).map(([owner, layer]) => ({ owner, layer: Number(layer) }));
}

export function listWindowOwners({ run = execFile } = {}) {
  return new Promise(resolve => {
    run("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_SCRIPT], { timeout: 3000, encoding: "utf8", maxBuffer: 256 * 1024 }, (error, stdout) => resolve(error ? [] : parseWindowOwners(stdout)));
  });
}

export function consentWindow(windows) {
  const found = windows.find(({ owner, layer }) => CONSENT_OWNERS.includes(owner) && !(owner === "UserNotificationCenter" && layer <= 0));
  return found ? { owner: found.owner } : null;
}

export const CONSENT_WORDS = "A macOS permission window is open on this Mac and waiting for someone to click Allow. A dog can't click it: macOS ignores clicks it doesn't get from a person. The person has been asked to click Allow on the Mac; wait for them, then try again.";

function reportOf(result) {
  try {
    const parsed = JSON.parse(result?.content?.[0]?.text ?? "");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

export const CONSENT_AFTER_MS = 5000;

export async function withConsentCheck(result, operation, { platform = process.platform, windows = listWindowOwners, elapsedMs = CONSENT_AFTER_MS } = {}) {
  if (platform !== "darwin" || !CHECKED_ACTIONS.has(operation?.action) || elapsedMs < CONSENT_AFTER_MS) return result;
  const stuck = result?.isError === true || reportOf(result)?.running === true;
  if (!stuck) return result;
  const found = consentWindow(await windows());
  if (!found) return result;
  return { ...result, content: [...(result.content ?? []), { type: "text", text: CONSENT_WORDS }], macPrompt: found };
}
