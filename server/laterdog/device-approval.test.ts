import { describe, expect, it } from "vitest";
import { shownDeviceApprovalStatus } from "../../shared/device-approval.ts";
import {
  DEVICE_APPROVAL_DEFAULT_MS,
  DEVICE_APPROVAL_MAX_MS,
  DeviceApprovalWatcher,
  deviceApprovalCard,
  deviceApprovalOutcome,
  deviceApprovalResumePrompt,
  parseDeviceApprovalInput,
  parseExpiresAt,
  runDeviceCheck,
  type DeviceApprovalWait,
} from "./device-approval.ts";

const NOW = Date.UTC(2026, 10, 8, 20, 0, 0);

describe("request_device_approval input", () => {
  it("accepts a device code flow and fills the default expiry", () => {
    const input = parseDeviceApprovalInput({ service: "GitHub CLI", url: "https://github.com/login/device", code: "ABCD-1234", check: "gh auth status" }, NOW);
    expect(input).toEqual({ service: "GitHub CLI", url: "https://github.com/login/device", code: "ABCD-1234", expiresAt: NOW + DEVICE_APPROVAL_DEFAULT_MS, check: "gh auth status" });
  });

  it("reads expiry as ISO, epoch seconds or milliseconds, caps it at an hour and refuses the past", () => {
    expect(parseExpiresAt("2026-11-08T20:10:00Z", NOW)).toBe(NOW + 600_000);
    expect(parseExpiresAt(NOW / 1000 + 300, NOW)).toBe(NOW + 300_000);
    expect(parseExpiresAt(String(NOW / 1000 + 300), NOW)).toBe(NOW + 300_000);
    expect(parseExpiresAt(NOW + 120_000, NOW)).toBe(NOW + 120_000);
    expect(parseExpiresAt(NOW + 10 * DEVICE_APPROVAL_MAX_MS, NOW)).toBe(NOW + DEVICE_APPROVAL_MAX_MS);
    expect(parseExpiresAt("2026-11-08T19:00:00Z", NOW)).toBeNull();
    expect(parseExpiresAt("soon", NOW)).toBeNull();
  });

  it("refuses a missing service, a non-https or credentialed url, a spaced code and a bad pid", () => {
    expect(parseDeviceApprovalInput({ url: "https://x.dev" }, NOW)).toMatch(/needs service/);
    expect(parseDeviceApprovalInput({ service: "x", url: "http://x.dev" }, NOW)).toMatch(/https/);
    expect(parseDeviceApprovalInput({ service: "x", url: "https://a:b@x.dev" }, NOW)).toMatch(/https/);
    expect(parseDeviceApprovalInput({ service: "x", url: "https://x.dev", code: "AB CD" }, NOW)).toMatch(/code/);
    expect(parseDeviceApprovalInput({ service: "x", url: "https://x.dev", pid: 1.5 }, NOW)).toMatch(/pid/);
  });

  it("builds the card payload with what it watches", () => {
    const base = { service: "Tailscale", url: "https://login.tailscale.com/a/abc", expiresAt: NOW + 60_000 };
    expect(deviceApprovalCard({ ...base, check: "tailscale status" })).toEqual({
      version: 1, service: "Tailscale", url: "https://login.tailscale.com/a/abc", expiresAt: NOW + 60_000, status: "waiting", watching: "check",
    });
    expect(deviceApprovalCard({ ...base, pid: 4242 }).watching).toBe("process");
    expect(deviceApprovalCard(base).watching).toBe("expiry");
    expect(shownDeviceApprovalStatus({ status: "waiting", expiresAt: NOW }, NOW)).toBe("expired");
  });

  it("maps each ending to a card status and a wake-up prompt", () => {
    expect(deviceApprovalOutcome("check")).toBe("approved");
    expect(deviceApprovalOutcome("person")).toBe("approved");
    expect(deviceApprovalOutcome("expiry")).toBe("expired");
    expect(deviceApprovalOutcome("process")).toBe("ended");
    expect(deviceApprovalResumePrompt({ service: "Codex" }, "check")).toContain("approved");
    expect(deviceApprovalResumePrompt({ service: "Codex" }, "expiry")).toContain("expired");
  });
});

describe("DeviceApprovalWatcher", () => {
  function setup(checks: Record<string, boolean>, alive: Set<number>) {
    let now = NOW;
    const settled: Array<[string, string]> = [];
    const ran: string[] = [];
    const watcher = new DeviceApprovalWatcher({
      now: () => now,
      runCheck: async (command) => {
        ran.push(command);
        return checks[command] ?? false;
      },
      alive: (pid) => alive.has(pid),
      settle: (wait, endedBy) => settled.push([wait.messageId, endedBy]),
    }, 60_000);
    return { watcher, settled, ran, advance: (ms: number) => { now += ms; } };
  }
  const wait = (messageId: string, extra: Partial<DeviceApprovalWait> = {}): DeviceApprovalWait =>
    ({ botId: "b", threadId: "t", messageId, expiresAt: NOW + 60_000, ...extra });

  it("wakes on a passing check, an exited pid and an expired code, each once", async () => {
    const checks: Record<string, boolean> = { "gh auth status": false };
    const alive = new Set([77]);
    const { watcher, settled, ran, advance } = setup(checks, alive);
    watcher.add(wait("gh", { check: "gh auth status" }));
    watcher.add(wait("ts", { pid: 77 }));
    watcher.add(wait("plain", { expiresAt: NOW + 10_000 }));
    await watcher.tick();
    expect(settled).toEqual([]);
    checks["gh auth status"] = true;
    alive.delete(77);
    await watcher.tick();
    expect(settled).toEqual([["ts", "process"], ["gh", "check"]]);
    advance(10_000);
    await watcher.tick();
    await watcher.tick();
    expect(settled).toEqual([["ts", "process"], ["gh", "check"], ["plain", "expiry"]]);
    expect(ran).toEqual(["gh auth status", "gh auth status"]);
    watcher.stop();
  });

  it("drops a removed wait and lists what waits in a chat", async () => {
    const { watcher, settled } = setup({}, new Set());
    watcher.add(wait("a", { pid: 9 }));
    expect(watcher.waitingIn("t").map((w) => w.messageId)).toEqual(["a"]);
    expect(watcher.remove({ threadId: "t", messageId: "a" })).toBe(true);
    await watcher.tick();
    expect(settled).toEqual([]);
  });

  it("runs a check in a shell and reports its exit", async () => {
    expect(await runDeviceCheck("true", undefined)).toBe(true);
    expect(await runDeviceCheck("exit 3", undefined)).toBe(false);
    expect(await runDeviceCheck("sleep 5", undefined, 100)).toBe(false);
  });
});
