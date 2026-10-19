import { describe, expect, it } from "vitest";

import { initialState, reducer, type Bot, type Group, type Message } from "@/state/store";
import {
  FIRST_PAINT_KEY,
  FIRST_PAINT_MAX_CHARS,
  FIRST_PAINT_MESSAGES,
  accountOf,
  firstPaintSnapshot,
  forgetFirstPaint,
  ownsFirstPaint,
  parseFirstPaint,
  readFirstPaint,
  saveFirstPaint,
  withFirstPaint,
} from "./first-paint";

const ORIGIN = "https://home.example.invalid";
const OWNER = { origin: ORIGIN, account: "email:owner@example.invalid" };

function memoryStorage(seed: Record<string, string> = {}, quota = Infinity): Storage {
  const values = new Map(Object.entries(seed));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (value.length > quota) throw new DOMException("full", "QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key) => { values.delete(key); },
  };
}

function throwingStorage(): Storage {
  const fail = () => { throw new DOMException("blocked", "SecurityError"); };
  return { length: 0, clear: fail, key: fail, getItem: fail, setItem: fail, removeItem: fail };
}

const message = (id: string, at: number, text = `message ${id}`): Message => ({ id, role: "bot", kind: "text", text, at });

function bot(id: string, messages: Message[], extra: Partial<Bot> = {}): Bot {
  return {
    id,
    threadId: `${id}-thread`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "slate",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake" },
    messages,
    ...extra,
  } as Bot;
}

function group(id: string, messages: Message[]): Group {
  return { id, threadId: `${id}-thread`, name: id, memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages } as Group;
}

const many = (prefix: string, count: number, size = 10) =>
  Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`, index + 1, "x".repeat(size)));

describe("first paint snapshot", () => {
  it("keeps the newest messages of each conversation and marks older ones as more", () => {
    const source = { bots: [bot("ada", many("a", FIRST_PAINT_MESSAGES + 5))], groups: [group("room", many("r", 3))], sections: ["Work"], selectedId: "ada" };
    const snapshot = parseFirstPaint(firstPaintSnapshot(source, OWNER, 10), ORIGIN)!;
    expect(snapshot.bots[0].messages).toHaveLength(FIRST_PAINT_MESSAGES);
    expect(snapshot.bots[0].messages[0].id).toBe("a-5");
    expect(snapshot.bots[0].hasMore).toBe(true);
    expect(snapshot.groups[0].messages).toHaveLength(3);
    expect(snapshot.groups[0].hasMore).toBe(false);
    expect(snapshot.sections).toEqual(["Work"]);
    expect(snapshot.selectedId).toBe("ada");
  });

  it("never paints a dog as working from a saved copy and drops inline images", () => {
    const working = bot("ada", [{ ...message("m", 1), png: "AAAA", hasImage: true }], { busy: true, activity: "working", turnStartedAt: 5 });
    const snapshot = parseFirstPaint(firstPaintSnapshot({ bots: [working], groups: [], sections: [], selectedId: "ada" }, OWNER, 1), ORIGIN)!;
    expect(snapshot.bots[0]).toMatchObject({ busy: false, activity: "idle", turnStartedAt: null });
    expect(snapshot.bots[0].messages[0].png).toBeUndefined();
    expect(snapshot.bots[0].messages[0].hasImage).toBe(true);
  });

  it("stays under the cap by emptying the least recent conversations first, never the selected one", () => {
    const size = Math.ceil(FIRST_PAINT_MAX_CHARS / 3 / FIRST_PAINT_MESSAGES);
    const oldest = bot("oldest", many("o", FIRST_PAINT_MESSAGES, size).map((entry) => ({ ...entry, at: entry.at })));
    const recent = bot("recent", many("n", FIRST_PAINT_MESSAGES, size).map((entry) => ({ ...entry, at: entry.at + 1_000 })));
    const selected = bot("selected", many("s", FIRST_PAINT_MESSAGES, size).map((entry) => ({ ...entry, at: entry.at - 1 })));
    const extra = bot("extra", many("e", FIRST_PAINT_MESSAGES, size).map((entry) => ({ ...entry, at: entry.at + 500 })));
    const serialized = firstPaintSnapshot({ bots: [oldest, recent, selected, extra], groups: [], sections: [], selectedId: "selected" }, OWNER, 1)!;
    expect(serialized.length).toBeLessThanOrEqual(FIRST_PAINT_MAX_CHARS);
    const snapshot = parseFirstPaint(serialized, ORIGIN)!;
    const byId = Object.fromEntries(snapshot.bots.map((entry) => [entry.id, entry]));
    expect(byId.selected.messages).toHaveLength(FIRST_PAINT_MESSAGES);
    expect(byId.oldest.messages).toEqual([]);
    expect(byId.oldest.hasMore).toBe(true);
    expect(byId.recent.messages).toHaveLength(FIRST_PAINT_MESSAGES);
    expect(snapshot.bots.map((entry) => entry.id)).toEqual(["oldest", "recent", "selected", "extra"]);
  });

  it("folds a live tool status line so nothing paints as still running", () => {
    const live = { ...message("t", 1), tool: { name: "shell", statusLine: "live" as const } };
    const snapshot = parseFirstPaint(firstPaintSnapshot({ bots: [bot("ada", [live])], groups: [], sections: [], selectedId: "ada" }, OWNER, 1), ORIGIN)!;
    expect(snapshot.bots[0].messages[0].tool).toEqual({ name: "shell", statusLine: "folded" });
  });

  it("always fits once enough conversations are emptied, right at the edge of the cap", () => {
    const selected = bot("selected", [message("s", 10)]);
    const base = firstPaintSnapshot({ bots: [selected, bot("other", [])], groups: [group("room", [])], sections: [], selectedId: "selected" }, OWNER, 1)!.length;
    for (const slack of [-40, -12, -3, -1, 0, 1, 2, 3, 12, 40]) {
      const text = "x".repeat(FIRST_PAINT_MAX_CHARS - base - 60 + slack);
      const serialized = firstPaintSnapshot({ bots: [selected, bot("other", [message("o", 1, text)])], groups: [group("room", [message("r", 2, "y".repeat(80))])], sections: [], selectedId: "selected" }, OWNER, 1);
      expect(serialized, `slack ${slack}`).not.toBeNull();
      expect(serialized!.length).toBeLessThanOrEqual(FIRST_PAINT_MAX_CHARS);
    }
  });

  it("refuses to save when even the selected conversation alone is over the cap", () => {
    const huge = bot("huge", [message("m", 1, "x".repeat(FIRST_PAINT_MAX_CHARS))]);
    expect(firstPaintSnapshot({ bots: [huge], groups: [], sections: [], selectedId: "huge" }, OWNER, 1)).toBeNull();
  });
});

describe("first paint owner", () => {
  it("names the server and the account from the session, and nobody for a refused or service session", () => {
    expect(accountOf({ kind: "loopback" })).toBe("this-computer");
    expect(accountOf({ kind: "loopback", trust: "service" })).toBeNull();
    expect(accountOf({ kind: "session", id: "s1", label: "", scopes: [], expiresAt: 0, email: "Owner@Example.invalid" })).toBe("email:owner@example.invalid");
    expect(accountOf({ kind: "session", id: "s1", label: "", scopes: [], expiresAt: 0 })).toBe("session:s1");
    expect(accountOf({ kind: "loopback", environmentId: "env-a" })).toBe("env-a/this-computer");
    expect(accountOf({ kind: "session", id: "s1", label: "", scopes: [], expiresAt: 0, email: "o@example.invalid", environmentId: "env-b" })).toBe("env-b/email:o@example.invalid");
    expect(accountOf({ kind: "unauthenticated", error: "" })).toBeNull();
    expect(accountOf({ kind: "unreachable", error: "" })).toBeNull();
  });

  it("belongs only to the same origin and the same account", () => {
    const snapshot = parseFirstPaint(firstPaintSnapshot({ bots: [bot("ada", [])], groups: [], sections: [], selectedId: "ada" }, OWNER, 1), ORIGIN)!;
    expect(ownsFirstPaint(snapshot, OWNER)).toBe(true);
    expect(ownsFirstPaint(snapshot, { ...OWNER, account: "email:guest@example.invalid" })).toBe(false);
    expect(ownsFirstPaint(snapshot, { ...OWNER, origin: "https://other.example.invalid" })).toBe(false);
  });

  it("is not read back on another origin, and a damaged or old copy is forgotten", () => {
    const serialized = firstPaintSnapshot({ bots: [bot("ada", [])], groups: [], sections: [], selectedId: "ada" }, OWNER, 1)!;
    expect(readFirstPaint("https://other.example.invalid", memoryStorage({ [FIRST_PAINT_KEY]: serialized }))).toBeNull();
    for (const raw of ["{not json", JSON.stringify({ ...JSON.parse(serialized), version: 0 }), JSON.stringify({ ...JSON.parse(serialized), bots: [{ id: 1 }] })]) {
      const store = memoryStorage({ [FIRST_PAINT_KEY]: raw });
      expect(readFirstPaint(ORIGIN, store)).toBeNull();
      expect(store.getItem(FIRST_PAINT_KEY)).toBeNull();
    }
  });
});

describe("first paint storage", () => {
  it("round-trips through storage", () => {
    const store = memoryStorage();
    const serialized = firstPaintSnapshot({ bots: [bot("ada", [message("m", 1)])], groups: [], sections: [], selectedId: "ada" }, OWNER, 1)!;
    expect(saveFirstPaint(serialized, store)).toBe(true);
    expect(readFirstPaint(ORIGIN, store)?.bots[0].messages[0].id).toBe("m");
    forgetFirstPaint(store);
    expect(readFirstPaint(ORIGIN, store)).toBeNull();
  });

  it("reads the newest saved copy, not one remembered from an earlier read", () => {
    const store = memoryStorage();
    saveFirstPaint(firstPaintSnapshot({ bots: [bot("ada", [])], groups: [], sections: [], selectedId: "ada" }, OWNER, 1)!, store);
    expect(readFirstPaint(ORIGIN, store)?.selectedId).toBe("ada");
    saveFirstPaint(firstPaintSnapshot({ bots: [bot("bea", [])], groups: [], sections: [], selectedId: "bea" }, OWNER, 2)!, store);
    expect(readFirstPaint(ORIGIN, store)?.selectedId).toBe("bea");
    expect(readFirstPaint(ORIGIN, store)).toBe(readFirstPaint(ORIGIN, store));
  });

  it("drops the old copy when the browser refuses the write", () => {
    const store = memoryStorage({ [FIRST_PAINT_KEY]: "old" }, 10);
    const serialized = firstPaintSnapshot({ bots: [bot("ada", [])], groups: [], sections: [], selectedId: "ada" }, OWNER, 1)!;
    expect(saveFirstPaint(serialized, store)).toBe(false);
    expect(store.getItem(FIRST_PAINT_KEY)).toBeNull();
  });

  it("never throws when storage itself is blocked", () => {
    const store = throwingStorage();
    expect(readFirstPaint(ORIGIN, store)).toBeNull();
    expect(saveFirstPaint("{}", store)).toBe(false);
    expect(() => forgetFirstPaint(store)).not.toThrow();
  });
});

describe("restoring the first paint", () => {
  const saved = () => parseFirstPaint(firstPaintSnapshot({
    bots: [bot("main", [message("old", 1)], { chiefOfStaff: true }), bot("ada", [message("a", 2)])],
    groups: [group("room", [])],
    sections: ["Work"],
    selectedId: "ada",
  }, OWNER, 1), ORIGIN)!;

  it("paints the saved sidebar and selection before anything is hydrated", () => {
    const restored = withFirstPaint(initialState, saved());
    expect(restored.restored).toBe(true);
    expect(restored.hydrated).toBeUndefined();
    expect(restored.bots.map((entry) => entry.id)).toEqual(["main", "ada"]);
    expect(restored.selectedId).toBe("ada");
    expect(withFirstPaint(initialState, { ...saved(), selectedId: "gone" }).selectedId).toBe("main");
  });

  it("lets the real hydrate replace the saved copy, keeping the selection when it still exists", () => {
    const restored = withFirstPaint(initialState, saved());
    const hydrated = reducer(restored, { type: "hydrate", bots: [bot("main", [message("old", 1), message("new", 3)], { chiefOfStaff: true })], groups: [], sections: [], computerControl: {} });
    expect(hydrated.hydrated).toBe(true);
    expect(hydrated.bots.map((entry) => entry.id)).toEqual(["main"]);
    expect(hydrated.bots[0].messages.map((entry) => entry.id)).toEqual(["old", "new"]);
    expect(hydrated.groups).toEqual([]);
    expect(hydrated.selectedId).toBe("main");
  });

  it("drops the saved copy for another account until the hydrate, and never after it", () => {
    const restored = withFirstPaint(initialState, saved());
    const dropped = reducer(restored, { type: "firstPaintDropped" });
    expect(dropped).toMatchObject({ restored: false, bots: [], groups: [], sections: [], selectedId: "" });
    const hydrated = reducer(restored, { type: "hydrate", bots: [bot("main", [])], groups: [], sections: [], computerControl: {} });
    expect(reducer(hydrated, { type: "firstPaintDropped" })).toBe(hydrated);
    expect(reducer(initialState, { type: "firstPaintDropped" })).toBe(initialState);
  });
});
