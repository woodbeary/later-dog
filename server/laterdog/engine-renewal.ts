import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { claudeCredentialsFile } from "./claude-keychain.ts";
import { CLAUDE_REFRESH_MARGIN_MS, claudeRefreshGate, claudeTokenExpiry, type ClaudeRefreshGate } from "./claude-refresh-lock.ts";

export const CLAUDE_RENEW_ARGS: readonly string[] = ["auth", "status", "--json"];
export const CLAUDE_RENEW_CHECK_MS = 60_000;
export const CLAUDE_RENEW_RUN_MS = 60_000;
export const CLAUDE_RENEW_RETRY_MS = 2 * 60_000;

export interface ClaudeRenewal { command: string; env: Record<string, string> }

export interface ClaudeRenewerOptions {
  gate?: Pick<ClaudeRefreshGate, "claim">;
  now?: () => number;
  expiry?: (file: string) => number | null;
  run?: (renewal: ClaudeRenewal) => Promise<boolean>;
  checkMs?: number;
  retryMs?: number;
  marginMs?: number;
}

export interface ClaudeRenewer {
  hold(renewal: ClaudeRenewal): () => void;
  check(): Promise<void>;
  held(): string[];
}

interface Held { renewal: ClaudeRenewal; holders: number; running: Promise<void> | null; failedAt: number | null }

export function claudeRenewalFile(renewal: ClaudeRenewal): string {
  return claudeCredentialsFile(renewal.env, renewal.env.HOME || homedir());
}

export function runClaudeRenewal(renewal: ClaudeRenewal, timeoutMs = CLAUDE_RENEW_RUN_MS): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(renewal.command, [...CLAUDE_RENEW_ARGS], {
        env: renewal.env, cwd: dirname(claudeRenewalFile(renewal)), timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true,
      }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

export function createClaudeRenewer(options: ClaudeRenewerOptions = {}): ClaudeRenewer {
  const gate = options.gate ?? claudeRefreshGate;
  const now = options.now ?? Date.now;
  const expiry = options.expiry ?? claudeTokenExpiry;
  const run = options.run ?? ((renewal: ClaudeRenewal) => runClaudeRenewal(renewal));
  const checkMs = options.checkMs ?? CLAUDE_RENEW_CHECK_MS;
  const retryMs = options.retryMs ?? CLAUDE_RENEW_RETRY_MS;
  const marginMs = options.marginMs ?? CLAUDE_REFRESH_MARGIN_MS;
  const held = new Map<string, Held>();
  let timer: NodeJS.Timeout | null = null;

  const due = (file: string) => {
    const at = expiry(file);
    return at !== null && at - now() <= marginMs;
  };

  const renew = (file: string, entry: Held): Promise<void> => {
    if (entry.running) return entry.running;
    if (!due(file)) return Promise.resolve();
    if (entry.failedAt !== null && now() - entry.failedAt < retryMs) return Promise.resolve();
    const running = (async () => {
      try {
        if (!(await gate.claim(entry.renewal.env))) return;
        const ok = await run(entry.renewal);
        entry.failedAt = ok && !due(file) ? null : now();
      } catch {
        entry.failedAt = now();
      }
    })().finally(() => { entry.running = null; });
    entry.running = running;
    return running;
  };

  const check = async () => {
    await Promise.all([...held].map(([file, entry]) => renew(file, entry)));
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return {
    hold(renewal) {
      const file = claudeRenewalFile(renewal);
      let entry = held.get(file);
      if (entry) entry.holders += 1;
      else {
        entry = { renewal, holders: 1, running: null, failedAt: null };
        held.set(file, entry);
      }
      if (!timer) {
        timer = setInterval(() => { void check(); }, checkMs);
        timer.unref?.();
      }
      void renew(file, entry);
      let released = false;
      const mine = entry;
      return () => {
        if (released) return;
        released = true;
        mine.holders -= 1;
        if (mine.holders <= 0 && held.get(file) === mine) held.delete(file);
        if (!held.size) stopTimer();
      };
    },
    check,
    held: () => [...held.keys()],
  };
}

export const claudeRenewer = createClaudeRenewer();
