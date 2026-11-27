import { StringDecoder } from "node:string_decoder";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { agentsMcpSession } from "./agents-mcp-session.ts";
import { permissionMcpSession } from "./permission-mcp-session.ts";

export interface ProxyHandle {
  write(bytes: Buffer): void;
  end(): void;
  kill(): void;
}

export type ProxyEnv = Record<string, string | undefined>;

interface LineSession {
  line(text: string): void;
  close(): void;
}

type Start = (env: ProxyEnv, send: (msg: unknown) => void) => LineSession;

function startFor(spec: { command: string; args?: string[] }): Start | null {
  const args = spec.args ?? [];
  if (args.length === 1 && args[0] === SPAWNED_PROXIES.agents) return (env, send) => agentsMcpSession(env, send);
  if (args.length === 2 && args[0] === SPAWNED_PROXIES.permission) return (env, send) => permissionMcpSession(env, args[1], send);
  return null;
}

export function servedInProcess(spec: { command: string; args?: string[] }): boolean {
  return startFor(spec) !== null;
}

export function inProcessProxy(spec: { command: string; args?: string[] }, env: ProxyEnv, stdout: (bytes: Buffer) => void, exit: (code: number) => void): ProxyHandle | null {
  const start = startFor(spec);
  if (!start) return null;
  let done = false;
  const finish = (code: number) => {
    if (done) return;
    done = true;
    session?.close();
    exit(code);
  };
  let session: LineSession | null = null;
  try {
    session = start(env, (msg) => { if (!done) stdout(Buffer.from(JSON.stringify(msg) + "\n")); });
  } catch {
    queueMicrotask(() => finish(1));
  }
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return {
    write(bytes) {
      if (done || !session) return;
      pending += decoder.write(bytes);
      let at = pending.indexOf("\n");
      while (at >= 0) {
        session.line(pending.slice(0, at));
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    },
    end() {
      if (done) return;
      pending += decoder.end();
      if (pending && session) session.line(pending);
      pending = "";
      finish(0);
    },
    kill() { finish(1); },
  };
}
