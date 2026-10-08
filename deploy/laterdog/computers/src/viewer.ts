// The desktop viewer later.dog links to: one full-window page that shows the computer's screen through noVNC.
// It is served at /desktop/<id>/<token>/ and loads noVNC's RFB module by relative URL, so the module (proxied from the
// container's own noVNC files) and the WebSocket both stay under the same signed path. The person watches by default and
// presses "Take over" to use the mouse and keyboard; "Hand back" returns control to the dog.

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Headers for the viewer page and its error pages: same-origin scripts only, nothing cached, the token never leaked. */
export function pageHeaders(requestUrl: URL, nonce: string): Record<string, string> {
  const socketOrigin = `${requestUrl.protocol === "https:" ? "wss:" : "ws:"}//${requestUrl.host}`;
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' data: blob:",
      `connect-src 'self' ${socketOrigin}`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  };
}

const STYLE = `
  :root { color-scheme: dark; --bg: #0e1013; --glass: rgba(18, 20, 24, 0.84); --line: rgba(255, 255, 255, 0.14); --text: #eceef1; --muted: #9aa1ab; --live: #3ccf6e; --wait: #f2b33d; --stop: #ff6a5f; --accent: #3d7cf5; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); overflow: hidden; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #screen { position: fixed; inset: 0; }
  #bar { position: fixed; right: 12px; bottom: 12px; display: flex; gap: 8px; align-items: center; z-index: 10; max-width: calc(100vw - 24px); }
  .pill, button { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: var(--glass); border: 1px solid var(--line); color: inherit; font: inherit; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .pill { min-width: 0; }
  #label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .pill[data-state="live"] .dot { background: var(--live); }
  .pill[data-state="wait"] .dot { background: var(--wait); animation: pulse 1.1s ease-in-out infinite; }
  .pill[data-state="stop"] .dot { background: var(--stop); }
  button { cursor: pointer; }
  button:hover { border-color: rgba(255, 255, 255, 0.3); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); }
  button[hidden] { display: none; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) { .pill[data-state="wait"] .dot { animation: none; } }
`;

export function viewerPage(options: { name: string; expiresAtMs: number; nonce: string }): string {
  const { name, expiresAtMs, nonce } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(name)} · later.dog</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div id="screen" role="application" aria-label="${escapeHtml(name)} desktop"></div>
<div id="bar">
  <button id="control" type="button" aria-pressed="false" hidden>Take over</button>
  <div class="pill" id="status" data-state="wait" role="status" aria-live="polite"><span class="dot"></span><span id="label">Connecting…</span></div>
</div>
<script type="module" nonce="${nonce}">
import RFB from "./core/rfb.js";

const EXPIRES_AT = ${Math.floor(expiresAtMs)};
const screen = document.getElementById("screen");
const pill = document.getElementById("status");
const label = document.getElementById("label");
const control = document.getElementById("control");
let rfb = null;
let failures = 0;
let controlling = false;
let finished = false;
let retry = 0;

function show(state, text) {
  pill.dataset.state = state;
  label.textContent = text;
}

function liveText() {
  return controlling ? "Live · you have control" : "Live";
}

function finish(text) {
  finished = true;
  clearTimeout(retry);
  control.hidden = true;
  show("stop", text);
}

function socketUrl() {
  const url = new URL("websockify", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

// What the server says about this link and its computer once the connection drops.
async function linkState() {
  try {
    const response = await fetch("status", { cache: "no-store" });
    if (response.status === 403 || response.status === 404) return "ended";
    if (!response.ok) return "unknown";
    const body = await response.json();
    return body.state;
  } catch {
    return "unknown";
  }
}

function connect() {
  if (finished) return;
  if (Date.now() >= EXPIRES_AT) return finish("This link has expired. Open the desktop again from later.dog.");
  show("wait", failures ? "Reconnecting…" : "Connecting…");
  rfb = new RFB(screen, socketUrl(), { shared: true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.viewOnly = !controlling;
  rfb.background = "#0e1013";
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
  rfb.addEventListener("connect", () => {
    failures = 0;
    control.hidden = false;
    show("live", liveText());
  });
  rfb.addEventListener("disconnect", async () => {
    rfb = null;
    control.hidden = true;
    if (finished) return;
    const state = await linkState();
    if (state === "ended") return finish("This link has ended. Open the desktop again from later.dog.");
    if (state === "sleeping" || state === "stopping") return finish("The computer is asleep. Wake it from later.dog, then open the desktop again.");
    if (state === "error") return finish("The computer stopped. Wake it from later.dog, then open the desktop again.");
    failures += 1;
    const delay = Math.min(15000, 600 * 2 ** Math.min(failures, 5));
    show("wait", state === "starting" ? "Starting…" : "Reconnecting…");
    retry = setTimeout(connect, delay);
  });
}

control.addEventListener("click", () => {
  controlling = !controlling;
  control.setAttribute("aria-pressed", String(controlling));
  control.textContent = controlling ? "Hand back" : "Take over";
  if (rfb) {
    rfb.viewOnly = !controlling;
    if (controlling) rfb.focus();
    show("live", liveText());
  }
});

connect();
</script>
</body>
</html>
`;
}

export function messagePage(options: { title: string; message: string; nonce: string }): string {
  const { title, message, nonce } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · later.dog</title>
<style nonce="${nonce}">${STYLE}
  main { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0; color: var(--muted); max-width: 36em; }
</style>
</head>
<body><main><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></main></body>
</html>
`;
}
