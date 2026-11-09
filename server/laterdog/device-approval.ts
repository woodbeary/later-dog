import { spawn } from "node:child_process";

import type { DeviceApprovalCardData, DeviceApprovalEndedBy, DeviceApprovalStatus, DeviceApprovalWatch } from "../../shared/device-approval.ts";

export const DEVICE_APPROVAL_DEFAULT_MS = 15 * 60_000;
export const DEVICE_APPROVAL_MAX_MS = 60 * 60_000;
export const DEVICE_APPROVAL_POLL_MS = 5_000;
export const DEVICE_APPROVAL_CHECK_TIMEOUT_MS = 20_000;
export const DEVICE_APPROVAL_CHECK_CHARS = 2_000;

export const DEVICE_APPROVAL_PROMPT =
  " For every device-code sign-in (codex login --device-auth, wrangler login, cf login, gh auth login, tailscale up and the like), start the login in the background, then call request_device_approval with its url, code, service, expiresAt, and a check command that succeeds once signed in (or the login's pid), and end the turn." +
  " later.dog shows a card with the code, Copy and Open, and wakes you when the check passes, the login exits or the code expires. Never paste the url and code into chat and ask to be told when it is approved.";

export interface DeviceApprovalInput {
  service: string;
  url: string;
  code?: string;
  expiresAt: number;
  check?: string;
  pid?: number;
}

export function parseExpiresAt(raw: unknown, now: number): number | null {
  if (raw === undefined || raw === null || raw === "") return now + DEVICE_APPROVAL_DEFAULT_MS;
  let at: number;
  if (typeof raw === "number" && Number.isFinite(raw)) at = raw < 1e11 ? raw * 1000 : raw;
  else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return parseExpiresAt(Number(raw.trim()), now);
  else if (typeof raw === "string") at = Date.parse(raw);
  else return null;
  if (!Number.isFinite(at) || at <= now) return null;
  return Math.min(at, now + DEVICE_APPROVAL_MAX_MS);
}

export function parseDeviceApprovalInput(raw: Record<string, unknown>, now: number): DeviceApprovalInput | string {
  const service = typeof raw.service === "string" ? raw.service.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!service) return "request_device_approval needs service: what is being signed in to, for example \"GitHub CLI\".";
  const rawUrl = typeof raw.url === "string" ? raw.url.trim() : "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "request_device_approval needs url: the https page where the code is entered.";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "url must be a plain https address, with no user name or password in it.";
  const code = typeof raw.code === "string" ? raw.code.trim() : "";
  if (code.length > 64 || /\s/.test(code)) return "code must be the short device code itself, at most 64 characters with no spaces.";
  const expiresAt = parseExpiresAt(raw.expiresAt ?? raw.expires_at, now);
  if (expiresAt === null) return "expiresAt must be a future time: an ISO date-time, or epoch seconds or milliseconds. Leave it out for 15 minutes.";
  const check = typeof raw.check === "string" ? raw.check.trim() : "";
  if (check.length > DEVICE_APPROVAL_CHECK_CHARS) return `check must be at most ${DEVICE_APPROVAL_CHECK_CHARS} characters.`;
  const pid = typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 1 ? raw.pid : undefined;
  if (raw.pid !== undefined && pid === undefined) return "pid must be the login process id, a whole number.";
  return { service, url: url.href, ...(code ? { code } : {}), expiresAt, ...(check ? { check } : {}), ...(pid ? { pid } : {}) };
}

export function deviceApprovalWatching(input: Pick<DeviceApprovalInput, "check" | "pid">): DeviceApprovalWatch {
  return input.check ? "check" : input.pid ? "process" : "expiry";
}

export function deviceApprovalCard(input: DeviceApprovalInput): DeviceApprovalCardData {
  return {
    version: 1,
    service: input.service,
    url: input.url,
    ...(input.code ? { code: input.code } : {}),
    expiresAt: input.expiresAt,
    status: "waiting",
    watching: deviceApprovalWatching(input),
  };
}

export function deviceApprovalTitle(card: Pick<DeviceApprovalCardData, "service">): string {
  return `Approve ${card.service} sign-in`;
}

export function deviceApprovalSubtitle(card: Pick<DeviceApprovalCardData, "code" | "url">): string {
  return card.code ? `Enter ${card.code} at ${card.url}` : `Open ${card.url}`;
}

export function deviceApprovalRequestedText(card: DeviceApprovalCardData): string {
  const wake = card.watching === "check"
    ? "as soon as your check command succeeds"
    : card.watching === "process" ? "when the login process exits" : "when they tap Approved";
  return [
    `The person now sees a card to approve the ${card.service} sign-in${card.code ? ` with code ${card.code}` : ""}, with Copy and Open.`,
    `End this turn now with one short line, for example: "Tap Open, enter the code, and I'll carry on once it's approved." Do not repeat the url or code in chat.`,
    `later.dog wakes you ${wake}, or when the code expires at ${new Date(card.expiresAt).toISOString()}.`,
  ].join(" ");
}

export function deviceApprovalResumePrompt(card: Pick<DeviceApprovalCardData, "service">, endedBy: DeviceApprovalEndedBy): string {
  const service = JSON.stringify(card.service);
  switch (endedBy) {
    case "check":
      return `later.dog device sign-in update: your check for ${service} now succeeds, so the sign-in is approved. Carry on with the task.`;
    case "process":
      return `later.dog device sign-in update: the ${service} login process exited. Check whether it signed in (run its status command), then carry on, or start a fresh login and request_device_approval again if it failed.`;
    case "person":
      return `later.dog device sign-in update: the person says they approved the ${service} sign-in. Confirm it worked with the CLI's status command, then carry on.`;
    case "expiry":
      return `later.dog device sign-in update: the ${service} device code expired before it was approved. If the work still needs it, start a fresh login and call request_device_approval with the new code; otherwise tell the person in one short line what is blocked.`;
    default:
      return `later.dog device sign-in update: the person dismissed the ${service} sign-in card. Do not ask again right away; carry on another way, or say in one short line what is blocked.`;
  }
}

export function deviceApprovalOutcome(endedBy: DeviceApprovalEndedBy): DeviceApprovalStatus {
  if (endedBy === "check" || endedBy === "person") return "approved";
  if (endedBy === "expiry") return "expired";
  return "ended";
}

export interface DeviceApprovalWait {
  botId: string;
  threadId: string;
  messageId: string;
  expiresAt: number;
  check?: string;
  cwd?: string;
  pid?: number;
}

export interface DeviceApprovalWatcherDeps {
  now(): number;
  runCheck(command: string, cwd: string | undefined): Promise<boolean>;
  alive(pid: number): boolean;
  settle(wait: DeviceApprovalWait, endedBy: DeviceApprovalEndedBy): void;
}

export class DeviceApprovalWatcher {
  private waits = new Map<string, DeviceApprovalWait>();
  private checking = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private deps: DeviceApprovalWatcherDeps;
  private pollMs: number;

  constructor(deps: DeviceApprovalWatcherDeps, pollMs = DEVICE_APPROVAL_POLL_MS) {
    this.deps = deps;
    this.pollMs = pollMs;
  }

  static key(wait: Pick<DeviceApprovalWait, "threadId" | "messageId">): string {
    return `${wait.threadId}:${wait.messageId}`;
  }

  add(wait: DeviceApprovalWait): void {
    this.waits.set(DeviceApprovalWatcher.key(wait), wait);
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.pollMs);
      this.timer.unref?.();
    }
  }

  remove(wait: Pick<DeviceApprovalWait, "threadId" | "messageId">): boolean {
    const removed = this.waits.delete(DeviceApprovalWatcher.key(wait));
    if (!this.waits.size) this.stop();
    return removed;
  }

  has(wait: Pick<DeviceApprovalWait, "threadId" | "messageId">): boolean {
    return this.waits.has(DeviceApprovalWatcher.key(wait));
  }

  waitingIn(threadId: string): DeviceApprovalWait[] {
    return [...this.waits.values()].filter((wait) => wait.threadId === threadId);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const now = this.deps.now();
    const checks: Promise<void>[] = [];
    for (const [key, wait] of [...this.waits]) {
      if (wait.expiresAt <= now) {
        this.finish(key, wait, "expiry");
        continue;
      }
      if (wait.check) {
        if (this.checking.has(key)) continue;
        this.checking.add(key);
        checks.push(this.deps.runCheck(wait.check, wait.cwd)
          .catch(() => false)
          .then((ok) => {
            this.checking.delete(key);
            if (ok && this.waits.get(key) === wait) this.finish(key, wait, "check");
          }));
        continue;
      }
      if (wait.pid && !this.deps.alive(wait.pid)) this.finish(key, wait, "process");
    }
    await Promise.all(checks);
  }

  private finish(key: string, wait: DeviceApprovalWait, endedBy: DeviceApprovalEndedBy): void {
    if (!this.waits.delete(key)) return;
    if (!this.waits.size) this.stop();
    this.deps.settle(wait, endedBy);
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function runDeviceCheck(command: string, cwd: string | undefined, timeoutMs = DEVICE_APPROVAL_CHECK_TIMEOUT_MS): Promise<boolean> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LATERDOG_")));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("bash", ["-lc", command], { cwd, env, stdio: "ignore", detached: process.platform !== "win32" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
