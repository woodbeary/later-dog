import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Page {
  goto(url: string, ready?: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  viewport(width: number, height: number, scale?: number): Promise<void>;
  reducedMotion(on: boolean): Promise<void>;
  screenshot(file: string, clip?: Clip): Promise<void>;
  clip(selector: string): Promise<Clip>;
  typeText(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  frames(count?: number): Promise<void>;
}

export interface Browser {
  page: Page;
  close(): Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function devtoolsUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(
      () => reject(new Error(`the browser did not open its DevTools port: ${seen.slice(-400)}`)),
      30_000,
    );
    child.stderr!.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the browser exited with ${code}: ${seen.slice(-400)}`));
    });
  });
}

export async function openBrowser(executable: string): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "wait-and-landing-browser-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const browserUrl = await devtoolsUrl(child);
  const port = new URL(browserUrl).port;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target) throw new Error("the browser opened no page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("could not reach the page over DevTools")),
      { once: true },
    );
  });
  let next = 0;
  const pending = new Map<number, Pending>();
  const waiters = new Map<string, Array<() => void>>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
    };
    if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message));
      else call?.resolve(message.result);
      return;
    }
    if (message.method) {
      const list = waiters.get(message.method) ?? [];
      waiters.delete(message.method);
      for (const wake of list) wake();
    }
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const once = (method: string) =>
    new Promise<void>((resolve) => waiters.set(method, [...(waiters.get(method) ?? []), resolve]));
  await send("Page.enable");
  await send("Runtime.enable");
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send<{
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "evaluation failed",
      );
    return result.result.value as T;
  };
  const waitFor = async (expression: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const page: Page = {
    async goto(url, ready = "document.readyState === 'complete'") {
      const loaded = once("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
      await waitFor(ready, 60_000);
      await evaluate("document.fonts.ready.then(() => true)");
    },
    evaluate,
    waitFor,
    async viewport(width, height, scale = 2) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: scale,
        mobile: false,
      });
    },
    async reducedMotion(on) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }],
      });
    },
    async screenshot(file, clip) {
      const shot = await send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      });
      writeFileSync(file, Buffer.from(shot.data, "base64"));
    },
    async clip(selector) {
      const box = await evaluate<Clip | null>(
        `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const box = node.getBoundingClientRect(); return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height }; })()`,
      );
      if (!box) throw new Error(`nothing matches ${selector}`);
      return box;
    },
    async typeText(text) {
      await send("Input.insertText", { text });
    },
    async pressEnter() {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    },
    async frames(count = 2) {
      await evaluate(
        `new Promise((resolve) => { let left = ${count}; const step = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(step)); requestAnimationFrame(step); })`,
      );
    },
  };
  return {
    page,
    async close() {
      socket.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
