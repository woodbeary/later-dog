import type { ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";

export interface AgyLaunch {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

type Call = (method: string, params: unknown) => Promise<any>;

export const AGY_INITIALIZE = {
  protocolVersion: 1,
  clientInfo: { name: "laterdog", version: "0.0.0" },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } },
};

export function agySignedOutError(error: unknown): boolean {
  const failure = error as { code?: unknown; message?: unknown } | null;
  return failure?.code === -32000 || /authentication required/i.test(String(failure?.message ?? ""));
}

export async function withAgy<T>(launch: AgyLaunch, work: (call: Call) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const child = spawnCli(launch.command, launch.args, { env: launch.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let buffer = "";
  let stderr = "";
  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.method !== undefined && message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
        continue;
      }
      const waiter = typeof message?.id === "number" ? pending.get(message.id) : undefined;
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(Object.assign(new Error(String(message.error.message ?? "Antigravity refused the request.")), { code: message.error.code }));
      } else waiter.resolve(message.result);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });
  child.on("error", failAll);
  child.on("exit", (code) => failAll(new Error(stripVTControlCharacters(stderr).trim() || `Antigravity stopped (exit ${code ?? "signal"}).`)));
  const call: Call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(call),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Antigravity did not answer in time.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void killCliTree(child, 2_000);
  }
}

async function listed(call: Call): Promise<boolean> {
  try {
    await call("session/list", {});
    return true;
  } catch (error) {
    if (agySignedOutError(error)) return false;
    throw error;
  }
}

export async function agySignedIn(launch: AgyLaunch): Promise<boolean> {
  return withAgy(launch, async (call) => {
    await call("initialize", AGY_INITIALIZE);
    return listed(call);
  });
}

export async function agyLoginArgs(launch: AgyLaunch): Promise<string[]> {
  try {
    const init = await withAgy(launch, (call) => call("initialize", AGY_INITIALIZE));
    const method = (Array.isArray(init?.authMethods) ? init.authMethods : []).find((entry: any) => entry?.id === "terminal-login");
    const args: unknown = method?.args;
    if (Array.isArray(args) && args.length && args.every((arg) => typeof arg === "string")) return args;
  } catch {}
  return ["--login"];
}

export async function agySignOut(launch: AgyLaunch): Promise<void> {
  const signedIn = await withAgy(launch, async (call) => {
    await call("initialize", AGY_INITIALIZE);
    await call("logout", {});
    return listed(call);
  });
  if (signedIn && await agySignedIn(launch)) throw new Error("Antigravity is still signed in. Try signing out again.");
}

type Agy = ChildProcessByStdio<Writable, Readable, Readable>;

interface Flow {
  flowId: string;
  child: Agy;
  url: string;
  expiresAt: number;
  phase: ProviderAuthenticationStatus["phase"];
  message?: string;
  output: string;
  exited: Promise<number | null>;
  timer?: NodeJS.Timeout;
}

export interface AntigravitySignInOptions {
  launch: () => Promise<AgyLaunch>;
  onChange?: () => Promise<void> | void;
  expiresInMs?: number;
  linkWaitMs?: number;
  finishWaitMs?: number;
}

const GOOGLE_LINK = /https:\/\/accounts\.google\.com\/\S+/u;

function lastWords(output: string): string | undefined {
  const lines = stripVTControlCharacters(output).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.findLast((line) => /couldn't log in/iu.test(line)) ?? lines.at(-1);
}

export class AntigravitySignIn {
  private readonly options: AntigravitySignInOptions;
  private flow: (Flow & { completing?: boolean }) | null = null;

  constructor(options: AntigravitySignInOptions) {
    this.options = options;
  }

  async start(): Promise<ProviderAuthenticationStart> {
    await this.cancel();
    const base = await this.options.launch();
    const env = { ...base.env };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const args = [...base.args, ...(await agyLoginArgs({ ...base, env }))];
    const child = spawnCli(base.command, args, { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] }) as Agy;
    const flow: Flow & { completing?: boolean } = {
      flowId: randomUUID(),
      child,
      url: "",
      expiresAt: Date.now() + (this.options.expiresInMs ?? 10 * 60_000),
      phase: "waiting",
      output: "",
      exited: new Promise((resolve) => child.once("close", (code) => resolve(code))),
    };
    this.flow = flow;
    const shown = new Promise<void>((resolve, reject) => {
      const read = (chunk: string) => {
        flow.output = (flow.output + chunk).slice(-64_000);
        const link = GOOGLE_LINK.exec(stripVTControlCharacters(flow.output));
        if (link && !flow.url) {
          flow.url = link[0];
          resolve();
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", read);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", read);
      child.once("error", reject);
      void flow.exited.then(() => {
        reject(new Error(lastWords(flow.output) ?? "Antigravity stopped before it showed a sign-in link."));
        if (this.flow === flow && !flow.completing) this.stop(flow, "failed", lastWords(flow.output) ?? "Antigravity stopped signing in. Start again.");
      });
    });
    let wait: NodeJS.Timeout | undefined;
    try {
      await Promise.race([shown, new Promise<never>((_, reject) => {
        wait = setTimeout(() => reject(new Error("Antigravity did not show a sign-in link. Try again.")), this.options.linkWaitMs ?? 30_000);
      })]);
    } catch (error) {
      this.stop(flow, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      clearTimeout(wait);
    }
    flow.timer = setTimeout(() => this.stop(flow, "expired", "The sign-in link expired. Start again."), Math.max(0, flow.expiresAt - Date.now()));
    flow.timer.unref?.();
    return { phase: "waiting", flowId: flow.flowId, authorizationUrl: flow.url, expiresAt: new Date(flow.expiresAt).toISOString() };
  }

  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    const flow = this.flow;
    if (!flow || flow.flowId !== flowId) {
      return { phase: "expired", flowId, authorizationUrl: null, expiresAt: null, message: "This sign-in is no longer available. Start a new sign-in." };
    }
    return {
      phase: flow.phase,
      flowId,
      authorizationUrl: flow.url,
      expiresAt: new Date(flow.expiresAt).toISOString(),
      ...(flow.message ? { message: flow.message } : {}),
    };
  }

  async complete(flowId: string, code: string): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.flowId !== flowId || flow.phase !== "waiting") {
      throw new Error(flow?.flowId === flowId && flow.message ? flow.message : "This sign-in is no longer available. Start a new sign-in.");
    }
    flow.completing = true;
    const before = flow.output.length;
    flow.child.stdin.write(`${code}\n`);
    let wait: NodeJS.Timeout | undefined;
    const exitCode = await Promise.race([flow.exited, new Promise<"late">((resolve) => {
      wait = setTimeout(() => resolve("late"), this.options.finishWaitMs ?? 120_000);
    })]);
    clearTimeout(wait);
    if (exitCode === 0) {
      clearTimeout(flow.timer);
      flow.phase = "succeeded";
      flow.message = undefined;
      await this.options.onChange?.();
      return;
    }
    const message = exitCode === "late"
      ? "Antigravity did not finish signing in. Start again."
      : lastWords(flow.output.slice(before)) ?? "Antigravity could not sign in. Start again.";
    this.stop(flow, "failed", message);
    throw new Error(message);
  }

  async cancel(): Promise<void> {
    if (this.flow) this.stop(this.flow, "cancelled", "Sign-in cancelled.");
  }

  async signOut(): Promise<void> {
    await this.cancel();
    await agySignOut(await this.options.launch());
    await this.options.onChange?.();
  }

  async dispose(): Promise<void> {
    await this.cancel();
  }

  private stop(flow: Flow, phase: Flow["phase"], message: string): void {
    clearTimeout(flow.timer);
    if (flow.phase === "waiting") {
      flow.phase = phase;
      flow.message = message;
    }
    if (flow.child.exitCode === null && flow.child.signalCode === null) void killCliTree(flow.child, 2_000);
  }
}
