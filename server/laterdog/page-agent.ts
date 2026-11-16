export const PAGE_CDP_PORT = 9339;
export const PAGE_READ_MAX_CHARS = 8_000;
export const PAGE_TEXT_MAX_CHARS = 4_000;

export const PAGE_AGENT_SOURCE = String.raw`
const input = JSON.parse(Buffer.from(process.argv[process.argv.length - 1], "base64").toString("utf8"));
const port = Number(process.env.LATERDOG_PAGE_CDP_PORT) || input.port;
const base = "http://127.0.0.1:" + port;
const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));
const finish = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };

function outline(scope, max) {
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { error: "Nothing on this page matches " + scope + "." };
  window.__ldNext = window.__ldNext || 1;
  const lines = [];
  let line = "";
  const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
  const flush = () => { const text = clean(line); if (text) lines.push(text); line = ""; };
  const token = (text) => { flush(); lines.push(text); };
  const ref = (el) => { if (!el.dataset.ldRef) el.dataset.ldRef = "e" + window.__ldNext++; return el.dataset.ldRef; };
  const hidden = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return true;
    const box = el.getBoundingClientRect();
    return box.width === 0 && box.height === 0 && el.tagName !== "OPTION";
  };
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return clean(label.innerText);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.innerText);
    return clean(el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "");
  };
  const labelsControl = (el) => (el.htmlFor && document.getElementById(el.htmlFor)) || el.querySelector("input,select,textarea");
  const inline = (el) => getComputedStyle(el).display.startsWith("inline");
  const field = (el) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return "#".repeat(Number(tag[1])) + " " + clean(el.innerText);
    if (tag === "A" && el.hasAttribute("href")) return 'link "' + clean(el.innerText || el.getAttribute("aria-label")) + '" [' + ref(el) + "]";
    if (tag === "BUTTON" || (tag === "INPUT" && ["submit", "button", "reset", "image"].includes(el.type)) || el.getAttribute("role") === "button") {
      return 'button "' + clean(el.innerText || el.value || el.getAttribute("aria-label")) + '"' + (el.disabled ? " disabled" : "") + " [" + ref(el) + "]";
    }
    if (tag === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return el.type + ' "' + labelOf(el) + '"' + (el.checked ? " checked" : "") + " [" + ref(el) + "]";
    if (tag === "INPUT" && el.type === "hidden") return "";
    if (tag === "INPUT" && el.type === "password") return 'password "' + labelOf(el) + '"' + (el.value ? " (filled)" : "") + " [" + ref(el) + "]";
    if (tag === "INPUT" || tag === "TEXTAREA") return 'textbox "' + labelOf(el) + '"' + (el.value ? " (filled)" : "") + " [" + ref(el) + "]";
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox "' + labelOf(el) + '"' + (clean(el.textContent) ? " (filled)" : "") + " [" + ref(el) + "]";
    if (tag === "SELECT") {
      const chosen = el.selectedIndex >= 0 ? clean(el.options[el.selectedIndex].text) : "";
      return 'select "' + labelOf(el) + '" [' + ref(el) + "]: " + Array.from(el.options).map((option) => clean(option.text)).join(" | ") + (chosen ? " (chosen: " + chosen + ")" : "");
    }
    if (tag === "IMG") return el.alt ? 'image "' + clean(el.alt) + '"' : "";
    return null;
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { line += child.textContent; continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toUpperCase();
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD"].includes(tag) || hidden(child)) continue;
      if (tag === "LABEL" && labelsControl(child)) { walkControls(child); continue; }
      const own = field(child);
      if (own !== null) { if (own) token(own); continue; }
      if (tag === "TABLE") {
        flush();
        for (const row of child.rows) lines.push("| " + Array.from(row.cells).map((cell) => clean(cell.innerText)).join(" | ") + " |");
        continue;
      }
      if (inline(child)) { walk(child); continue; }
      flush();
      if (tag === "LI") line = "- ";
      walk(child);
      flush();
    }
  };
  const walkControls = (label) => {
    for (const control of label.querySelectorAll("input,select,textarea")) { const own = field(control); if (own) token(own); }
  };
  if (scope && field(root)) token(field(root)); else walk(root);
  flush();
  let text = lines.join("\n");
  if (text.length > max) text = text.slice(0, max) + "\n[cut at " + max + " characters; read one part with selector]";
  return { title: document.title, url: location.href, text };
}

function textOf(ref, selector, max) {
  const el = ref ? document.querySelector('[data-ld-ref="' + ref + '"]') : document.querySelector(selector);
  if (!el) return { error: ref ? "No element " + ref + " on this page; read the page again." : "Nothing on this page matches " + selector + "." };
  const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
  if (field) return { text: (el.isContentEditable ? (el.textContent || "").trim() : el.value) ? "(filled; field values are not shown)" : "(empty)" };
  const copy = el.cloneNode(true);
  for (const hidden of copy.querySelectorAll("script,style,noscript,template,[contenteditable]")) hidden.textContent = hidden.matches("[contenteditable]") && (hidden.textContent || "").trim() ? " (filled) " : "";
  let text = (copy.textContent || "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  if (text.length > max) text = text.slice(0, max) + "\n[cut at " + max + " characters]";
  return { text };
}

function act(action, ref, value) {
  const el = document.querySelector('[data-ld-ref="' + ref + '"]');
  if (!el) return { error: "No element " + ref + " on this page; read the page again." };
  el.scrollIntoView({ block: "center", inline: "center" });
  if (action === "click") { el.click(); return { done: "Clicked " + ref + "." }; }
  if (action === "fill") {
    if (!("value" in el) && !el.isContentEditable) return { error: ref + " is not a field you can type in." };
    el.focus();
    if (el.isContentEditable) el.textContent = value;
    else Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { done: "Filled " + ref + "." };
  }
  if (action === "select") {
    if (el.tagName !== "SELECT") return { error: ref + " is not a list to choose from." };
    const wanted = String(value).trim().toLowerCase();
    const option = Array.from(el.options).find((each) => each.text.trim().toLowerCase() === wanted || each.value.toLowerCase() === wanted);
    if (!option) return { error: "No option " + value + " in " + ref + "; its options are " + Array.from(el.options).map((each) => each.text.trim()).join(", ") + "." };
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { done: "Chose " + option.text.trim() + " in " + ref + "." };
  }
  return { error: "Unknown page action." };
}

async function pages() {
  try {
    const res = await fetch(base + "/json/list", { signal: AbortSignal.timeout(2000) });
    return (await res.json()).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  } catch { return null; }
}

function connect(url) {
  return new Promise((settle, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Set();
    let next = 0;
    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data));
      if (data.id === undefined) { for (const listener of listeners) listener(data); return; }
      const waiting = pending.get(data.id);
      if (!waiting) return;
      pending.delete(data.id);
      if (data.error) waiting.reject(new Error(data.error.message)); else waiting.resolve(data.result);
    };
    socket.onerror = () => reject(new Error("could not reach the browser"));
    socket.onopen = () => settle({
      send: (method, params) => new Promise((resolve, fail) => { next += 1; pending.set(next, { resolve, reject: fail }); socket.send(JSON.stringify({ id: next, method, params: params || {} })); }),
      on: (listener) => listeners.add(listener),
      close: () => socket.close(),
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text);
  return result.result.value;
}

async function settled(cdp) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if (await evaluate(cdp, "document.readyState") === "complete") return; } catch {}
    await sleep(100);
  }
}

async function navigating(cdp, run) {
  let started = false;
  let loaded = false;
  cdp.on((event) => {
    if (event.method === "Page.frameStartedLoading") started = true;
    if (event.method === "Page.loadEventFired") loaded = true;
  });
  await cdp.send("Page.enable");
  const result = await run();
  await sleep(400);
  if (!started) return { result, moved: false };
  const deadline = Date.now() + 15000;
  while (!loaded && Date.now() < deadline) await sleep(100);
  await settled(cdp);
  return { result, moved: true };
}

const KEYS = { Enter: [13, "\r"], Tab: [9, ""], Escape: [27, ""], Backspace: [8, ""], Delete: [46, ""], Space: [32, " "], ArrowDown: [40, ""], ArrowUp: [38, ""], ArrowLeft: [37, ""], ArrowRight: [39, ""], PageDown: [34, ""], PageUp: [33, ""], Home: [36, ""], End: [35, ""] };

async function press(cdp, key) {
  const known = KEYS[key];
  const code = known ? known[0] : key.toUpperCase().charCodeAt(0);
  const text = known ? known[1] : key.length === 1 ? key : "";
  const event = { key: key === "Space" ? " " : key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...event, ...(text ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

async function reading(cdp, note) {
  const page = await evaluate(cdp, "(" + outline.toString() + ")(" + JSON.stringify(input.selector || "") + "," + input.max + ")");
  if (page.error) return { ok: false, error: page.error };
  return { ok: true, text: (note ? note + "\n" : "") + "Page: " + page.title + " (" + page.url + ")\n" + page.text };
}

async function main() {
  let list = await pages();
  if (input.action === "open") {
    const deadline = Date.now() + 20000;
    while ((!list || !list.length) && Date.now() < deadline) { await sleep(250); list = await pages(); }
  }
  if (list === null) return finish({ ok: false, error: "The browser on the cloud computer is not open. Open a page with page_open first." });
  if (!list.length) return finish({ ok: false, error: "The browser has no page open. Open one with page_open." });
  const cdp = await connect(list[0].webSocketDebuggerUrl);
  try {
    if (input.action === "open") {
      const moved = await navigating(cdp, () => cdp.send("Page.navigate", { url: input.url }));
      if (moved.result && moved.result.errorText) return finish({ ok: false, error: "The page did not open: " + moved.result.errorText });
      await settled(cdp);
      return finish(await reading(cdp, ""));
    }
    if (input.action === "read") { await settled(cdp); return finish(await reading(cdp, "")); }
    if (input.action === "text") {
      const found = await evaluate(cdp, "(" + textOf.toString() + ")(" + JSON.stringify(input.ref || "") + "," + JSON.stringify(input.selector || "body") + "," + input.textMax + ")");
      return finish(found.error ? { ok: false, error: found.error } : { ok: true, text: found.text });
    }
    if (input.action === "back") {
      const moved = await navigating(cdp, () => evaluate(cdp, "history.back()"));
      return finish(moved.moved ? await reading(cdp, "Went back.") : { ok: false, error: "There is no earlier page in this tab." });
    }
    if (input.action === "press") {
      const moved = await navigating(cdp, () => press(cdp, input.key));
      return finish(moved.moved ? await reading(cdp, "Pressed " + input.key + "; the page changed.") : { ok: true, text: "Pressed " + input.key + "." });
    }
    const moved = await navigating(cdp, () => evaluate(cdp, "(" + act.toString() + ")(" + JSON.stringify(input.action) + "," + JSON.stringify(input.ref) + "," + JSON.stringify(input.value === undefined ? "" : input.value) + ")"));
    if (moved.result.error) return finish({ ok: false, error: moved.result.error });
    return finish(moved.moved ? await reading(cdp, moved.result.done + " The page changed.") : { ok: true, text: moved.result.done });
  } finally {
    cdp.close();
  }
}

main().catch((error) => finish({ ok: false, error: "The page tool failed: " + (error && error.message ? error.message : String(error)) }));
`;
