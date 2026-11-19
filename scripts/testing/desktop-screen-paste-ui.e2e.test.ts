import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { pageHeaders, viewerPage } from "../../deploy/laterdog/computers/src/viewer.ts";
import { CLIPBOARD_WORDS } from "../../deploy/laterdog/computers/src/viewer-clipboard.ts";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-laterdog-ui.ts";
import { fakeVnc } from "./fake-vnc.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NOVNC_PUBLIC = join(ROOT, "third_party", "novnc", "public");
const forced = process.env.LATERDOG_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log(`skipping desktop screen paste ui e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}); set LATERDOG_UI_E2E=1 to install the pinned release`);
const run = enabled ? it : it.skip;
const evidenceDir = process.env.LATERDOG_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.LATERDOG_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "laterdog-ui-evidence-"));
const ownsEvidenceDir = !process.env.LATERDOG_UI_EVIDENCE_DIR;
const MIME: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

afterAll(async () => {
  if (ownsEvidenceDir) await removeTempDir(evidenceDir);
});

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => done(port));
    });
  });
}

class Page {
  private id = 0;
  private waiting = new Map<number, (reply: { result?: any; error?: { message: string } }) => void>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") this.waiting.get(message.id)?.(message);
    });
  }

  static async open(port: number): Promise<Page> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const target = targets.find((entry) => entry.type === "page");
        if (target) {
          const socket = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise((ready, fail) => { socket.addEventListener("open", ready); socket.addEventListener("error", fail); });
          return new Page(socket);
        }
      } catch {}
      await new Promise((wait) => setTimeout(wait, 200));
    }
    throw new Error("the browser did not open its debugging port");
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    const reply = await new Promise<{ result?: any; error?: { message: string } }>((done) => {
      this.waiting.set(id, done);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    this.waiting.delete(id);
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result?.result?.value as T;
  }

  async key(type: "rawKeyDown" | "keyUp", key: string, code: string, keyCode: number, modifiers: number, options: { location?: number; autoRepeat?: boolean } = {}): Promise<void> {
    const { location = 0, autoRepeat = false } = options;
    await this.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, location, autoRepeat });
  }

  close(): void {
    this.socket.close();
  }
}

const META = 4;

run("Cmd+V in the desktop's screen window types the Mac's clipboard into the computer, and Cmd+C copies its text back", async () => {
  const nonce = "fixturenonce";
  const desktop = await fakeVnc({
    serve: (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        res.writeHead(200, pageHeaders(new URL(`http://${req.headers.host}/`), nonce));
        res.end(viewerPage({ name: "Rex", expiresAtMs: Date.now() + 3_600_000, nonce }));
        return;
      }
      if (url.pathname === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: "running" }));
        return;
      }
      const file = normalize(join(NOVNC_PUBLIC, decodeURIComponent(url.pathname)));
      if (!file.startsWith(NOVNC_PUBLIC)) return void res.writeHead(404).end();
      try {
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    },
  });
  const profile = mkdtempSync(join(tmpdir(), "laterdog-screen-paste-"));
  let browser: ChildProcess | undefined;
  let page: Page | undefined;
  const evidence: Record<string, unknown> = {};
  try {
    const { chrome } = await ensureUiBrowser(process.env);
    if (!chrome) throw new Error("no Chrome for Testing is installed for the interface checks");
    const port = await freePort();
    browser = spawn(chrome, [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
    ], { stdio: "ignore" });
    page = await Page.open(port);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        readText: async () => { window.__readCount = (window.__readCount || 0) + 1; return window.__macClipboard || ""; },
        writeText: async (text) => { window.__macCopied = text; },
      } });`,
    });
    await page.send("Page.navigate", { url: `http://127.0.0.1:${desktop.port}/` });
    await expect.poll(() => page!.evaluate<string>("document.getElementById('label')?.textContent ?? ''"), { timeout: 20_000 }).toBe("Live");
    await page.evaluate("document.querySelector('#screen canvas')?.focus(); true");

    await page.evaluate(`window.__macClipboard = "Code 4821"; true`);
    const before = desktop.strokes.length;
    await page.key("rawKeyDown", "Meta", "MetaLeft", 91, META, { location: 1 });
    await page.key("rawKeyDown", "v", "KeyV", 86, META);
    await page.key("keyUp", "v", "KeyV", 86, META);
    await page.key("keyUp", "Meta", "MetaLeft", 91, 0, { location: 1 });
    const typed = [..."Code 4821"].map((character) => character.codePointAt(0)!);
    await expect.poll(() => desktop.strokes.slice(before).filter(([, down]) => down).map(([keysym]) => keysym).filter((keysym) => typed.includes(keysym)).length, { timeout: 10_000 }).toBe(typed.length);
    const strokes = desktop.strokes.slice(before);
    evidence.pasteStrokes = strokes;
    const downs = strokes.filter(([, down]) => down).map(([keysym]) => keysym);
    const commandKey = downs[0]!;
    expect(downs.slice(1)).toEqual(typed);
    const commandReleased = strokes.findIndex(([keysym, down]) => keysym === commandKey && !down);
    const firstTyped = strokes.findIndex(([keysym, down]) => keysym === typed[0] && down);
    expect(commandReleased).toBeGreaterThan(-1);
    expect(commandReleased).toBeLessThan(firstTyped);
    expect(downs).not.toContain(0x76);
    expect(await page.evaluate<number>("window.__readCount")).toBe(1);
    expect(await page.evaluate<string>("document.getElementById('label').textContent")).toBe(CLIPBOARD_WORDS.pasted);

    const clipboard = desktop.nextClipboard();
    await page.evaluate(`window.__macClipboard = "Paste me as well"; true`);
    await page.key("rawKeyDown", "v", "KeyV", 86, META);
    await page.key("keyUp", "v", "KeyV", 86, META);
    const [sent] = await clipboard as [string];
    evidence.computerClipboard = sent;
    expect(sent).toBe("Paste me as well");

    await expect.poll(() => page!.evaluate<number>("window.__readCount"), { timeout: 5_000 }).toBe(2);
    const beforeHeld = desktop.strokes.length;
    await page.key("rawKeyDown", "v", "KeyV", 86, META, { autoRepeat: true });
    await page.key("rawKeyDown", "v", "KeyV", 86, META, { autoRepeat: true });
    await new Promise((wait) => setTimeout(wait, 300));
    expect(await page.evaluate<number>("window.__readCount")).toBe(2);
    expect(desktop.strokes.slice(beforeHeld)).toEqual([]);

    const long = "x".repeat(2500);
    await page.evaluate(`window.__macClipboard = "x".repeat(${long.length}); true`);
    const beforeLong = desktop.strokes.length;
    const cut = desktop.nextClipboard().then(([text]) => ({ text: String(text), at: Date.now() }));
    const control = desktop.untilKey(0xffe3).then(() => Date.now());
    await page.key("rawKeyDown", "v", "KeyV", 86, META);
    await page.key("keyUp", "v", "KeyV", 86, META);
    const arrived = await cut;
    const pressed = await control;
    expect(arrived.text).toBe(long);
    await expect.poll(() => desktop.strokes.length - beforeLong, { timeout: 5_000 }).toBe(4);
    const longStrokes = desktop.strokes.slice(beforeLong);
    evidence.longPaste = { characters: arrived.text.length, settledMs: pressed - arrived.at, strokes: longStrokes };
    expect(longStrokes).toEqual([[0xffe3, true], [0x76, true], [0x76, false], [0xffe3, false]]);
    expect(pressed - arrived.at).toBeGreaterThanOrEqual(280);
    expect(await page.evaluate<string>("document.getElementById('label').textContent")).toBe(CLIPBOARD_WORDS.pasted);

    desktop.sendClipboard("Order 7731 confirmed");
    await new Promise((wait) => setTimeout(wait, 300));
    const beforeCopy = desktop.strokes.length;
    await page.key("rawKeyDown", "c", "KeyC", 67, META);
    await page.key("keyUp", "c", "KeyC", 67, META);
    await expect.poll(() => page!.evaluate<string>("window.__macCopied ?? ''"), { timeout: 5_000 }).toBe("Order 7731 confirmed");
    evidence.copied = await page.evaluate<string>("window.__macCopied");
    expect(desktop.strokes.slice(beforeCopy).filter(([, down]) => down)).toEqual([]);
    expect(await page.evaluate<string>("document.getElementById('label').textContent")).toBe(CLIPBOARD_WORDS.copied);
  } finally {
    evidence.strokes = desktop.strokes;
    page?.close();
    if (browser) await waitForExit(browser, { signal: "SIGTERM" });
    await desktop.close();
    await removeTempDir(profile);
    writeFileSync(join(evidenceDir, "desktop-screen-paste.json"), JSON.stringify(evidence, null, 2));
  }
}, forced ? 600_000 : 180_000);
