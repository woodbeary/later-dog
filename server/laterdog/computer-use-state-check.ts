import type { PageCheckResult, StateCheckRule } from "./computer-use-done.ts";

export const DEVTOOLS_PORT = 9222;
export const STATE_CHECK_TIMEOUT_MS = 20_000;
export const STATE_SCRIPT_PATH = "/tmp/laterdog-computer-use/state-check.mjs";

export const STATE_CHECK_SCRIPT = `
const decode = (value) => Buffer.from(value ?? "", "base64").toString("utf8");
const rule = JSON.parse(decode(process.argv[2]));
const windowName = decode(process.argv[3]).trim();
const port = Number(process.env.LATERDOG_DEVTOOLS_PORT || ${DEVTOOLS_PORT});
const answer = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
setTimeout(() => answer({ error: "timeout" }), 10000).unref();
let targets;
try {
  const listed = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(5000) });
  targets = await listed.json();
} catch {
  answer({ error: "devtools" });
}
const pages = Array.isArray(targets) ? targets.filter((target) => target && target.type === "page" && typeof target.webSocketDebuggerUrl === "string") : [];
if (!pages.length) answer({ error: "no_page" });
const named = pages.filter((page) => typeof page.title === "string" && page.title && windowName.startsWith(page.title));
const page = named[0] ?? pages[0];
const socket = new WebSocket(page.webSocketDebuggerUrl);
socket.onerror = () => answer({ error: "devtools" });
socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
  expression: "JSON.stringify({ url: location.href, text: document.body ? document.body.innerText : \\"\\" })", returnByValue: true } }));
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== 1) return;
  let seen;
  try { seen = JSON.parse(message.result.result.value); } catch { answer({ error: "unreadable" }); }
  const url = String(seen.url ?? "");
  let expected = null;
  try { expected = new URL(rule.url); } catch { expected = null; }
  let where = "";
  let origin = "";
  try { const parsed = new URL(url); where = parsed.origin + parsed.pathname; origin = parsed.origin; } catch { where = ""; }
  const urlMatches = expected !== null && origin === expected.origin && url.startsWith(expected.href);
  const textMatches = String(seen.text ?? "").includes(rule.contains);
  answer({ where, urlMatches, textMatches, active: named.length > 0 || pages.length === 1 });
};
`;

export function stateCheckCommand(rule: StateCheckRule): string {
  const script = Buffer.from(STATE_CHECK_SCRIPT, "utf8").toString("base64");
  const encoded = Buffer.from(JSON.stringify(rule), "utf8").toString("base64");
  return [
    `mkdir -p ${STATE_SCRIPT_PATH.replace(/\/[^/]+$/, "")}`,
    `printf %s '${script}' | base64 -d > ${STATE_SCRIPT_PATH}`,
    `node ${STATE_SCRIPT_PATH} '${encoded}' "$(xdotool getactivewindow getwindowname 2>/dev/null | head -c 1000 | base64 -w0)"`,
  ].join(" && ");
}

const NO_DEVTOOLS = "The desktop's browser has no local DevTools port, so the state check could not read it.";

export function readStateCheck(exitCode: number | null, stdout: string): PageCheckResult {
  if (exitCode !== 0) return { passed: false, detail: "The state check did not run on the desktop." };
  let answer: Record<string, unknown>;
  try { answer = JSON.parse(stdout) as Record<string, unknown>; } catch { return { passed: false, detail: "The state check gave an answer later.dog could not read." }; }
  if (answer.error === "devtools") return { passed: false, detail: NO_DEVTOOLS };
  if (answer.error === "no_page") return { passed: false, detail: "The desktop's browser has no open page." };
  if (typeof answer.error === "string") return { passed: false, detail: "The state check could not read the browser's page." };
  const where = typeof answer.where === "string" && answer.where ? answer.where.slice(0, 300) : "an unreadable address";
  const tab = answer.active === true ? "The active tab" : "A tab (the active one could not be told apart)";
  if (answer.urlMatches !== true) return { passed: false, detail: `${tab} is on ${where}, not the expected address.` };
  if (answer.textMatches !== true) return { passed: false, detail: `${tab} is on ${where}; the expected text is not on the page.` };
  return { passed: answer.active === true, detail: answer.active === true ? `The active tab is on ${where} and shows the expected text.` : `${tab} is on ${where} and shows the expected text, so the person decides.` };
}
