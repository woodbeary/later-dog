import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AWAY_MARKER, AWAY_RULES, type AwayPlan, type PlannedChat } from "./folder-away-plan.ts";
import {
  BRING_BACK_FAILED_LINE, BRING_BACK_ROOM_LINE, BRINGING_BACK_LINE, FolderAwayCoordinator, awayLine, folderAwayBridge,
  type AwayStatus, type Brought, type FolderAwayBridge,
} from "./folder-away.ts";

const GB = 1024 ** 3;
const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function plan(chats: Array<Partial<PlannedChat> & { threadId: string }>): AwayPlan {
  return {
    at: 0, tookMs: 0, complete: true, disk: null, underPressure: false, rules: AWAY_RULES,
    totals: { folders: chats.length, bytes: 0, away: 0, byTimer: { chats: 0, bytes: 0 }, byPressure: { chats: 0, bytes: 0, passes: 0 } },
    projected: null,
    chats: chats.map((chat) => ({ botId: "dog", bytes: GB, carriedBytes: GB, leftOutBytes: 0, files: 1, lastUsedAt: 0, newestAt: 0, verdict: "moves", ...chat })),
  };
}

function setup(options: { disk?: { totalBytes: number; freeBytes: number }; enabled?: boolean } = {}) {
  const tasksDir = mkdtempSync(join(tmpdir(), "folder-away-server-"));
  made.push(tasksDir);
  const calls: string[] = [];
  const away = new Set<string>();
  const markAway = (threadId: string, botId = "dog") => {
    away.add(threadId);
    mkdirSync(join(tasksDir, botId, threadId), { recursive: true });
    writeFileSync(join(tasksDir, botId, threadId, AWAY_MARKER), "{}");
  };
  const comeBack = (threadId: string, botId = "dog") => {
    away.delete(threadId);
    rmSync(join(tasksDir, botId, threadId, AWAY_MARKER), { force: true });
  };
  const behaviour = {
    bringBack: [] as Array<Brought | Error>,
    status: { away: 0, bytes: 0, released: 0, chats: [] } as AwayStatus | null,
    supported: true,
    inUse: new Set<string>(),
    gone: new Set<string>(),
    plan: plan([]),
    flipInUseOnPack: null as string | null,
  };
  const bridge: FolderAwayBridge = {
    async status() { calls.push("status"); return behaviour.supported ? behaviour.status : null; },
    async pack(_botId, threadId) {
      calls.push(`pack ${threadId}`);
      if (behaviour.flipInUseOnPack === threadId) behaviour.inUse.add(threadId);
      return { id: `id-${threadId}`, record: "r", files: 1, bytes: GB };
    },
    async swap(id) { calls.push(`swap ${id}`); markAway(id.slice(3)); return { moved: true, bytes: GB }; },
    async bringBack(botId, threadId) {
      calls.push(`bring-back ${threadId}`);
      const next = behaviour.bringBack.shift() ?? { back: true };
      if (next instanceof Error) throw next;
      if (next.back) comeBack(threadId, botId);
      return next;
    },
    async release(_botId, threadId) { calls.push(`release ${threadId}`); return { released: true }; },
  };
  const lines: string[] = [];
  const changes: string[] = [];
  const disk = options.disk ?? { totalBytes: 20 * GB, freeBytes: 10 * GB };
  const coordinator = new FolderAwayCoordinator({
    bridge, tasksDir, enabled: () => options.enabled ?? true,
    chat: (_botId, threadId) => ({ exists: !behaviour.gone.has(threadId), inUse: behaviour.inUse.has(threadId) }),
    plan: async () => behaviour.plan,
    disk: () => disk,
    changed: (_botId, threadId) => changes.push(`${threadId}:${coordinator.line(threadId) ?? "-"}`),
    log: (line) => lines.push(line),
    retryMs: 1, maxRetryMs: 4,
  });
  return { tasksDir, calls, behaviour, coordinator, lines, changes, markAway, disk };
}

describe("bringing a chat's files back before anything uses them", () => {
  it("does nothing and asks nobody when the folder is here", async () => {
    const f = setup();
    expect(await f.coordinator.ensureChatFolder("dog", "chat-1")).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("shows one plain line while the files come back and clears it after", async () => {
    const f = setup();
    f.markAway("chat-1");
    expect(await f.coordinator.ensureChatFolder("dog", "chat-1")).toBe(true);
    expect(f.calls).toEqual(["bring-back chat-1"]);
    expect(f.changes).toEqual([`chat-1:${BRINGING_BACK_LINE}`, "chat-1:-"]);
    expect(f.coordinator.line("chat-1")).toBeUndefined();
  });

  it("keeps the turn waiting through failures, says so in plain words, and never proceeds on an empty folder", async () => {
    const f = setup();
    f.markAway("chat-1");
    f.behaviour.bringBack = [new Error("storage unreachable"), new Error("storage unreachable"), { back: true }];
    expect(await f.coordinator.ensureChatFolder("dog", "chat-1")).toBe(true);
    expect(f.calls.filter((call) => call.startsWith("bring-back"))).toHaveLength(3);
    expect(f.changes).toContain(`chat-1:${BRING_BACK_FAILED_LINE}`);
    expect(f.lines[0]).toMatch(/could not bring back chat chat-1's files yet: storage unreachable; trying again/);
  });

  it("stops waiting only when the turn itself is cancelled, leaving the folder away", async () => {
    const f = setup();
    f.markAway("chat-1");
    let tries = 0;
    f.behaviour.bringBack = Array.from({ length: 50 }, () => new Error("down"));
    expect(await f.coordinator.ensureChatFolder("dog", "chat-1", () => ++tries < 4)).toBe(false);
    expect(f.coordinator.isAway("dog", "chat-1")).toBe(true);
    expect(f.coordinator.line("chat-1")).toBeUndefined();
  });

  it("makes room by moving other idle chats when there is not enough space, then brings the files back", async () => {
    const f = setup();
    f.markAway("chat-1");
    f.behaviour.plan = plan([{ threadId: "chat-1", bytes: 9 * GB }, { threadId: "big", bytes: 3 * GB }, { threadId: "busy", verdict: "in-use", bytes: 8 * GB }, { threadId: "small", bytes: GB }]);
    f.behaviour.bringBack = [{ short: { needBytes: 2 * GB, freeBytes: 1, bytes: 2 * GB } }, { back: true }];
    expect(await f.coordinator.ensureChatFolder("dog", "chat-1")).toBe(true);
    expect(f.calls).toEqual(["bring-back chat-1", "status", "pack big", "swap id-big", "bring-back chat-1"]);
  });

  it("says plainly when there is still no room, and keeps trying", async () => {
    const f = setup();
    f.markAway("chat-1");
    const short = { short: { needBytes: 2 * GB, freeBytes: 1, bytes: 2 * GB } };
    f.behaviour.bringBack = [short, short, { back: true }];
    expect(await f.coordinator.ensureChatFolder("dog", "chat-1")).toBe(true);
    expect(f.changes).toContain(`chat-1:${BRING_BACK_ROOM_LINE}`);
    expect(f.lines[0]).toMatch(/need 2048 MB more free space before they can come back; trying again/);
  });

  it("finds the chat behind any path inside the chat folders and ignores paths elsewhere", async () => {
    const f = setup();
    f.markAway("chat-1");
    expect(f.coordinator.chatOfPath(join(f.tasksDir, "dog", "chat-1", "src", "a.ts"))).toEqual({ botId: "dog", threadId: "chat-1" });
    expect(f.coordinator.chatOfPath(join(f.tasksDir, "dog"))).toBeNull();
    expect(f.coordinator.chatOfPath("/somewhere/else")).toBeNull();
    expect(await f.coordinator.ensurePaths(["/somewhere/else", null, join(f.tasksDir, "dog", "chat-1", "notes.md")])).toBe(true);
    expect(f.calls).toEqual(["bring-back chat-1"]);
  });
});

describe("moving chats away", () => {
  it("moves nothing while the home's setting is off, but still records removed chats", async () => {
    const f = setup({ enabled: false });
    f.behaviour.plan = plan([{ threadId: "old" }]);
    f.behaviour.status = { away: 1, bytes: GB, released: 0, chats: [{ botId: "dog", threadId: "deleted", files: 1, bytes: GB, movedAt: "x", released: false }] };
    f.behaviour.gone.add("deleted");
    await f.coordinator.sweep();
    expect(f.calls).toEqual(["status", "status", "release deleted"]);
  });

  it("on the daily sweep moves every chat idle for 30 days, oldest first, at most 2 GB a pass", async () => {
    const f = setup();
    f.behaviour.plan = plan([{ threadId: "b", lastUsedAt: 20 }, { threadId: "a", lastUsedAt: 10 }, { threadId: "c", lastUsedAt: 30 }, { threadId: "w", verdict: "would-move-under-pressure" }]);
    await f.coordinator.sweep();
    expect(f.calls.filter((call) => call.startsWith("swap"))).toEqual(["swap id-a", "swap id-b"]);
    expect(f.coordinator.report()).toMatchObject({ supported: true, enabled: true, lastMove: { moved: 2, bytes: 2 * GB } });
  });

  it("under a fifth free, moves the largest week-idle folders until 30% is free", async () => {
    const f = setup({ disk: { totalBytes: 20 * GB, freeBytes: 3 * GB } });
    f.behaviour.plan = plan([
      { threadId: "small", bytes: 0.5 * GB, verdict: "would-move-under-pressure" },
      { threadId: "big", bytes: 1.5 * GB, verdict: "would-move-under-pressure" },
      { threadId: "old", bytes: 0.4 * GB },
      { threadId: "busy", bytes: 9 * GB, verdict: "in-use" },
    ]);
    expect(f.coordinator.pressureCheck()).not.toBeNull();
    await f.coordinator.sweep();
    expect(f.calls.filter((call) => call.startsWith("swap"))).toEqual(["swap id-big", "swap id-small"]);
  });

  it("does not swap a chat that came into use while it was being copied, nor one asked for in the last hour", async () => {
    const f = setup();
    f.behaviour.plan = plan([{ threadId: "a", lastUsedAt: 1 }, { threadId: "b", lastUsedAt: 2 }]);
    f.behaviour.flipInUseOnPack = "a";
    await f.coordinator.ensureChatFolder("dog", "b");
    await f.coordinator.sweep();
    expect(f.calls).toEqual(["status", "status", "pack a"]);
  });

  it("does nothing on an image that cannot move folders", async () => {
    const f = setup();
    f.behaviour.supported = false;
    f.behaviour.plan = plan([{ threadId: "a" }]);
    await f.coordinator.sweep();
    expect(f.calls).toEqual(["status"]);
    expect(f.lines).toEqual(["this home's image cannot move chat folders; nothing will be moved"]);
  });
});

describe("bringing every folder back", () => {
  it("checks free space first and stops with a plain message, changing nothing", async () => {
    const f = setup({ disk: { totalBytes: 20 * GB, freeBytes: 4 * GB } });
    f.behaviour.status = { away: 2, bytes: 3 * GB, released: 0, chats: [
      { botId: "dog", threadId: "a", files: 1, bytes: 2 * GB, movedAt: "x", released: false },
      { botId: "dog", threadId: "b", files: 1, bytes: GB, movedAt: "x", released: false },
    ] };
    const answer = await f.coordinator.bringAllBack();
    expect(answer).toMatchObject({ ok: false, brought: 0 });
    expect(answer.message).toBe("Not enough free space to bring every chat's files back: they need 3072 MB and only 2048 MB can be used without running the home low. Nothing was changed.");
    expect(f.calls).toEqual(["status"]);
  });

  it("brings each one back and reports any that could not come back yet", async () => {
    const f = setup();
    f.behaviour.status = { away: 2, bytes: 2 * GB, released: 1, chats: [
      { botId: "dog", threadId: "a", files: 1, bytes: GB, movedAt: "x", released: false },
      { botId: "dog", threadId: "b", files: 1, bytes: GB, movedAt: "x", released: false },
      { botId: "dog", threadId: "gone", files: 1, bytes: GB, movedAt: "x", released: true },
    ] };
    f.behaviour.bringBack = [{ back: true }, new Error("down")];
    const answer = await f.coordinator.bringAllBack();
    expect(answer).toMatchObject({ ok: false, brought: 1, failed: 1 });
    expect(answer.message).toMatch(/still safe in Cloud storage/);
    expect(f.calls.filter((call) => call.startsWith("bring-back"))).toEqual(["bring-back a", "bring-back b"]);
  });
});

describe("the storage line and the bridge", () => {
  it("says in one plain line how many chats are away", () => {
    expect(awayLine(0, 0)).toBeNull();
    expect(awayLine(1, 5 * 1024 * 1024)).toBe("1 chat's files are kept in Cloud storage (5 MB) and come back when the chat is used.");
    expect(awayLine(12, 3.5 * GB)).toBe("12 chats' files are kept in Cloud storage (3.5 GB) and come back when the chat is used.");
  });

  it("talks only to loopback, treats a missing endpoint as an older image, and passes refusals on", async () => {
    expect(() => folderAwayBridge("http://example.com/", "t")).toThrow(/loopback/);
    const seen: string[] = [];
    const answers: Record<string, Response> = {
      "/folders/status": new Response("no", { status: 404 }),
      "/folders/pack": Response.json({ error: "that chat has no folder" }, { status: 500 }),
    };
    const fetcher = (async (input: URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(`${init?.method} ${input.pathname} ${headers.authorization}`);
      return answers[input.pathname]!;
    }) as unknown as typeof fetch;
    const bridge = folderAwayBridge("http://127.0.0.1:9/", "secret", fetcher);
    expect(await bridge.status()).toBeNull();
    await expect(bridge.pack("dog", "chat")).rejects.toThrow("that chat has no folder");
    expect(seen).toEqual(["GET /folders/status Bearer secret", "POST /folders/pack Bearer secret"]);
  });
});
