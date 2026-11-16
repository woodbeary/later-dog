import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCloudComputerTool, type CloudComputerResult, type RemoteExec } from "../../server/cloud-computer-tools.ts";
import type { AppConfig } from "../../server/config.ts";
import { FIXTURE_ACCOUNT, FIXTURE_ANSWERS, startFixtureSite } from "./fixture-site.ts";

export const NO_IMAGE = "This model cannot see images; describe the page in text instead.";
const CHROMIUM_CANDIDATES = [process.env.LATERDOG_BROWSER_STEPS_CHROMIUM, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];

export interface HeadlessBrowser {
  port: number;
  exec: RemoteExec;
  stop(): Promise<void>;
}

export function localExec(env: Record<string, string>): RemoteExec {
  return (command, signal) => new Promise((settle) => {
    const child = spawn("bash", ["-c", command], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    let done = false;
    const finish = (result: { ok: boolean; exitCode: number | null; stdout: string; stderr: string }) => {
      if (done) return;
      done = true;
      child.stdout.destroy();
      child.stderr.destroy();
      settle(result);
    };
    child.on("error", (error) => finish({ ok: false, exitCode: null, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code, stdout, stderr }));
    child.on("exit", (code) => { setTimeout(() => finish({ ok: code === 0, exitCode: code, stdout, stderr }), 100); });
  });
}

async function freePort(): Promise<number> {
  return new Promise((settle, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => settle(port));
    });
  });
}

function chromiumPath(): string | undefined {
  return CHROMIUM_CANDIDATES.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

export const headlessBrowser = {
  available(): boolean {
    return Boolean(chromiumPath()) && spawnSync("node", ["-e", "process.exit(typeof WebSocket === 'function' ? 0 : 1)"]).status === 0;
  },
  async start(): Promise<HeadlessBrowser> {
    const binary = chromiumPath();
    if (!binary) throw new Error("no Chromium found");
    const port = await freePort();
    const profile = mkdtempSync(join(tmpdir(), "laterdog-no-vision-"));
    const child: ChildProcess = spawn(binary, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1280,800", "about:blank",
    ], { stdio: "ignore" });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const up = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.ok, () => false);
      if (up) break;
      await new Promise((settle) => setTimeout(settle, 200));
    }
    return {
      port,
      exec: localExec({ LATERDOG_PAGE_CDP_PORT: String(port) }),
      async stop() {
        child.kill("SIGTERM");
        await new Promise((settle) => setTimeout(settle, 300));
        rmSync(profile, { recursive: true, force: true });
      },
    };
  },
};

export interface NoVisionStep { tool: string; bytes: number; seconds: number; refusedImage: boolean }
export interface NoVisionRun { task: "find" | "form" | "table"; steps: NoVisionStep[]; answer: string; correct: boolean }

const PAGE_TOOLS_ON = { features: { browser: true } } as AppConfig;

export function refIn(page: string, kind: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${kind} "${escaped}"[^\\n]*?\\[(e\\d+)\\]`).exec(page);
  if (!match) throw new Error(`no ${kind} "${label}" on the page:\n${page.slice(0, 2000)}`);
  return match[1]!;
}

export function caller(exec: RemoteExec, cfg: AppConfig = PAGE_TOOLS_ON) {
  const steps: NoVisionStep[] = [];
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<string> => {
    const started = performance.now();
    const result: CloudComputerResult = await runCloudComputerTool(cfg, "fixture", tool, args, new AbortController().signal, undefined, undefined, exec);
    const refusedImage = result.content.some((part) => part.type === "image");
    const text = result.content.map((part) => (part.type === "text" ? part.text : NO_IMAGE)).join("\n");
    steps.push({ tool, bytes: Buffer.byteLength(text), seconds: (performance.now() - started) / 1000, refusedImage });
    if (result.isError) throw new Error(`${tool} failed: ${text.slice(0, 400)}`);
    return text;
  };
  return { steps, call };
}

export async function noVisionTasks(browser: HeadlessBrowser): Promise<NoVisionRun[]> {
  const site = await startFixtureSite();
  const runs: NoVisionRun[] = [];
  try {
    {
      const { steps, call } = caller(browser.exec);
      const shop = await call("page_open", { url: `${site.origin}/shop` });
      const price = /Blue Kettle · (\$[\d.]+)/.exec(shop)?.[1] ?? "";
      const policy = await call("page_click", { ref: refIn(shop, "link", "Shipping policy") });
      const threshold = /free on orders over (\$\d+)/.exec(policy)?.[1] ?? "";
      const answer = `${price}; free over ${threshold}`;
      runs.push({ task: "find", steps, answer, correct: price === FIXTURE_ANSWERS.find.price && threshold === FIXTURE_ANSWERS.find.threshold });
    }
    {
      const { steps, call } = caller(browser.exec);
      const form = await call("page_open", { url: `${site.origin}/contact` });
      await call("page_fill", { ref: refIn(form, "textbox", "Full name"), text: "Ada Fixture" });
      await call("page_fill", { ref: refIn(form, "textbox", "Email"), text: "ada@example.test" });
      await call("page_fill", { ref: refIn(form, "textbox", "Phone"), text: "555-0100" });
      await call("page_select", { ref: refIn(form, "select", "Topic"), option: "Billing" });
      await call("page_fill", { ref: refIn(form, "textbox", "Message"), text: "My kettle arrived without a lid." });
      const sent = await call("page_click", { ref: refIn(form, "button", "Send message") });
      const answer = /reference is (\S+?)\./.exec(sent)?.[1] ?? "";
      runs.push({ task: "form", steps, answer, correct: answer === FIXTURE_ANSWERS.form.reference });
    }
    {
      const { steps, call } = caller(browser.exec);
      const wall = await call("page_open", { url: `${site.origin}/orders` });
      await call("page_fill", { ref: refIn(wall, "textbox", "Username"), text: FIXTURE_ACCOUNT.username });
      await call("page_fill", { ref: refIn(wall, "password", "Password"), text: FIXTURE_ACCOUNT.password });
      const table = await call("page_click", { ref: refIn(wall, "button", "Sign in") });
      const row = table.split("\n").find((line) => line.includes(`#${FIXTURE_ANSWERS.table.order}`)) ?? "";
      const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
      const answer = `${cells[3] ?? ""} ${cells[4] ?? ""}`.trim();
      runs.push({ task: "table", steps, answer, correct: cells[3] === FIXTURE_ANSWERS.table.total && cells[4] === FIXTURE_ANSWERS.table.status });
    }
  } finally {
    await site.close();
  }
  return runs;
}
