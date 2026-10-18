import { describe, expect, it, vi } from "vitest";
import {
  MAX_SERVER_FAILURES,
  OUTBOX_KEY,
  createOutbox,
  holdDelay,
  parseOutbox,
  readOutbox,
  sendOutcome,
  writeOutbox,
  type OutboxItem,
} from "./outbox";

const item = (sendId: string, threadId = "thread", queuedAt = 1): OutboxItem => ({
  sendId,
  threadId,
  target: { kind: "bot", botId: "bot" },
  text: `words ${sendId}`,
  queuedAt,
});

const status = (code: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(String(code)), { name: "ApiError", status: code, ...extra });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function clock() {
  const timers: Array<{ ms: number; run: () => void; live: boolean }> = [];
  return {
    timers,
    after: (ms: number, run: () => void) => {
      const timer = { ms, run, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
    fire: async () => {
      const live = timers.filter((timer) => timer.live);
      timers.length = 0;
      for (const timer of live) timer.run();
      await flush();
    },
  };
}

describe("what a failed send means", () => {
  it("holds a lost connection, a slow answer, a waking home and a gateway, and keeps the home's wait", () => {
    expect(sendOutcome(new TypeError("Failed to fetch"))).toEqual({ kind: "hold" });
    expect(sendOutcome(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toEqual({ kind: "hold" });
    expect(sendOutcome(status(503, { wake: "waking", retryAfterMs: 2_000 }))).toEqual({ kind: "hold", afterMs: 2_000 });
    expect(sendOutcome(status(502))).toEqual({ kind: "hold", afterMs: undefined });
    expect(sendOutcome(status(429, { retryAfterMs: 5_000 }))).toEqual({ kind: "hold", afterMs: 5_000 });
  });

  it("tries a server error again a few times, and takes a refusal as final", () => {
    expect(sendOutcome(status(500))).toEqual({ kind: "retry" });
    expect(sendOutcome(status(409))).toEqual({ kind: "final" });
    expect(sendOutcome(status(400))).toEqual({ kind: "final" });
    expect(sendOutcome(new Error("settings were not saved"))).toEqual({ kind: "final" });
  });

  it("waits a little longer each time, never more than fifteen seconds", () => {
    expect([1, 2, 3, 4, 5, 9].map(holdDelay)).toEqual([2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });
});

describe("the outbox", () => {
  it("saves a message before its first attempt and forgets it once it is accepted", async () => {
    const saved: OutboxItem[][] = [];
    const attempt = vi.fn(async () => {
      expect(saved.at(-1)?.map((entry) => entry.sendId)).toEqual(["a"]);
    });
    const outbox = createOutbox({ attempt, save: (items) => saved.push([...items]), onFinal: vi.fn() });
    outbox.enqueue(item("a"));
    await flush();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)).toEqual([]);
  });

  it("keeps one dog's messages in order, and does not let a held dog hold another", async () => {
    const tick = clock();
    const posted: string[] = [];
    let offline = true;
    const outbox = createOutbox({
      after: tick.after,
      save: () => {},
      onFinal: vi.fn(),
      attempt: async (entry) => {
        posted.push(entry.sendId);
        if (entry.threadId === "held" && offline) throw new TypeError("Failed to fetch");
      },
    });
    outbox.enqueue(item("first", "held", 1));
    outbox.enqueue(item("second", "held", 2));
    outbox.enqueue(item("other", "free", 3));
    await flush();
    expect(posted).toEqual(["first", "other"]);
    expect(outbox.items().map((entry) => entry.sendId)).toEqual(["first", "second"]);
    offline = false;
    await tick.fire();
    expect(posted).toEqual(["first", "other", "first", "second"]);
    expect(outbox.items()).toEqual([]);
  });

  it("never gives up on a lost connection, and honours the home's retry-after while it wakes", async () => {
    const tick = clock();
    const onFinal = vi.fn();
    let tries = 0;
    const outbox = createOutbox({
      after: tick.after,
      save: () => {},
      onFinal,
      attempt: async () => {
        tries += 1;
        if (tries <= 12) throw new TypeError("Failed to fetch");
        if (tries === 13) throw status(503, { wake: "waking", retryAfterMs: 3_000 });
      },
    });
    outbox.enqueue(item("a"));
    await flush();
    for (let i = 0; i < 12; i++) await tick.fire();
    expect(tick.timers.at(-1)?.ms).toBe(3_000);
    await tick.fire();
    expect(tries).toBe(14);
    expect(onFinal).not.toHaveBeenCalled();
    expect(outbox.items()).toEqual([]);
  });

  it("hands a refusal back once and moves on to the next message", async () => {
    const onFinal = vi.fn();
    const posted: string[] = [];
    const outbox = createOutbox({
      save: () => {},
      onFinal,
      attempt: async (entry) => {
        posted.push(entry.sendId);
        if (entry.sendId === "refused") throw status(409);
      },
    });
    outbox.enqueue(item("refused", "thread", 1));
    outbox.enqueue(item("next", "thread", 2));
    await flush();
    expect(posted).toEqual(["refused", "next"]);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal.mock.calls[0]![0].sendId).toBe("refused");
  });

  it("stops trying a server error after a few attempts", async () => {
    const tick = clock();
    const onFinal = vi.fn();
    const attempt = vi.fn(async () => { throw status(500); });
    const outbox = createOutbox({ after: tick.after, save: () => {}, onFinal, attempt });
    outbox.enqueue(item("a"));
    await flush();
    for (let i = 0; i < MAX_SERVER_FAILURES; i++) await tick.fire();
    expect(attempt).toHaveBeenCalledTimes(MAX_SERVER_FAILURES);
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it("settles a held message when its echo arrives, and sends the next one right away", async () => {
    const tick = clock();
    const posted: string[] = [];
    let offline = true;
    const outbox = createOutbox({
      after: tick.after,
      save: () => {},
      onFinal: vi.fn(),
      attempt: async (entry) => {
        posted.push(entry.sendId);
        if (offline) throw new TypeError("Failed to fetch");
      },
    });
    outbox.enqueue(item("first", "thread", 1));
    outbox.enqueue(item("second", "thread", 2));
    await flush();
    offline = false;
    outbox.acknowledge("first");
    await flush();
    expect(posted).toEqual(["first", "second"]);
    expect(outbox.items()).toEqual([]);
    expect(tick.timers.every((timer) => !timer.live)).toBe(true);
  });

  it("restores saved messages in order and waits for resume before sending them", async () => {
    const posted: string[] = [];
    const outbox = createOutbox({ save: () => {}, onFinal: vi.fn(), attempt: async (entry) => { posted.push(entry.sendId); } });
    outbox.restore([item("later", "thread", 5), item("earlier", "thread", 2)]);
    await flush();
    expect(posted).toEqual([]);
    outbox.resume();
    await flush();
    expect(posted).toEqual(["earlier", "later"]);
  });
});

describe("the saved outbox", () => {
  it("round-trips through storage and ignores damaged or foreign data", () => {
    const values = new Map<string, string>();
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const group: OutboxItem = { sendId: "g", threadId: "room", target: { kind: "group", groupId: "team" }, text: "hi all", queuedAt: 7, recovery: { draftId: "group:team:room", text: "hi all" } };
    writeOutbox(store, [item("a"), group]);
    expect(readOutbox(store)).toEqual([item("a"), group]);
    writeOutbox(store, []);
    expect(values.has(OUTBOX_KEY)).toBe(false);
    expect(parseOutbox("{not json")).toEqual([]);
    expect(parseOutbox(JSON.stringify({ version: 99, items: [item("a")] }))).toEqual([]);
    expect(parseOutbox(JSON.stringify({ version: 1, items: [{ sendId: "x" }, item("b")] }))).toEqual([item("b")]);
  });

  it("works with no storage at all", () => {
    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(() => writeOutbox(broken, [item("a")])).not.toThrow();
    expect(readOutbox(broken)).toEqual([]);
    expect(readOutbox(undefined)).toEqual([]);
  });
});
