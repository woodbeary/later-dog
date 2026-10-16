import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WireMessage } from "../../shared/wire.ts";
import {
  STATUS_LINE_EVERY_MS,
  STATUS_LINE_MAX_WORDS,
  STATUS_LINE_QUIET_MS,
  createStatusLines,
  fileStatusLineLedger,
  foldedStatusTool,
  liveStatusTool,
  speaksToPerson,
  statusLineFor,
  statusLineTimingFromEnv,
  statusWords,
  threadWork,
  type OpenStatusLine,
  type ThreadWork,
} from "./status-lines.ts";

const THREAD = "t1";

function fixture(options: { ledger?: OpenStatusLine[]; changed?: (threadId: string) => void } = {}) {
  let clock = 1_000_000;
  let nextId = 0;
  const work = new Map<string, ThreadWork>([[THREAD, "working"]]);
  const messages: WireMessage[] = [];
  const patches: Array<{ id: string; tool: WireMessage["tool"] }> = [];
  let ledger = options.ledger ?? [];
  const lines = createStatusLines({
    work: (threadId) => work.get(threadId) ?? "idle",
    append: (threadId, message) => {
      const full = { ...message, id: `m${++nextId}`, at: clock } as WireMessage;
      messages.push(full);
      lines.observe(threadId, full);
      return full;
    },
    patch: (_threadId, messageId, patch) => {
      const at = messages.findIndex((message) => message.id === messageId);
      if (at === -1) return null;
      messages[at] = { ...messages[at]!, ...patch };
      patches.push({ id: messageId, tool: patch.tool });
      return messages[at]!;
    },
    ledger: { read: () => ledger, write: (open) => { ledger = open; } },
    ...(options.changed ? { changed: options.changed } : {}),
  }, { now: () => clock });
  const post = (message: Omit<WireMessage, "id" | "at">) => {
    const full = { ...message, id: `m${++nextId}`, at: clock } as WireMessage;
    messages.push(full);
    lines.observe(THREAD, full);
    return full;
  };
  const step = (spoken: string, turnId = "turn-1") => post({ role: "bot", kind: "activity", turnId, tool: { name: "Bash", spoken } });
  const advance = (ms: number) => {
    clock += ms;
    lines.tick();
  };
  const statusLines = () => messages.filter((message) => message.tool?.statusLine);
  return { lines, work, messages, patches, post, step, advance, statusLines, ledger: () => ledger };
}

describe("the words in a status line", () => {
  it("turns a command description into what the dog is doing", () => {
    expect(statusWords("run the focused tests")).toBe("running the focused tests");
    expect(statusWords("Check git status.")).toBe("checking git status");
    expect(statusWords("kill the dev server")).toBe("stopping the dev server");
    expect(statusWords("running a few commands")).toBe("running a few commands");
    expect(statusWords("checking with Scout")).toBe("checking with Scout");
    expect(statusWords("  ")).toBe("");
  });

  it("never says a placeholder or asks for input in a status line", () => {
    expect(statusWords("working on it")).toBe("");
    expect(statusWords("needs your input")).toBe("");
    expect(statusLineFor(["making edits", "needs your input"])).toEqual({ text: "Still on it: making edits", words: "making edits" });
    expect(statusLineFor([])).toEqual({ text: "Still on it" });
    expect(statusLineFor(["working on it"])).toEqual({ text: "Still on it" });
  });

  it("keeps the line to twelve words or fewer", () => {
    const line = statusLineFor(["run every single end to end test in the repository against the staging fixture"]);
    expect(line.text.replace("…", "").split(" ").length).toBeLessThanOrEqual(STATUS_LINE_MAX_WORDS);
    expect(line.text).toBe("Still on it: running every single end to end test in the…");
  });

  it("masks a secret a command description happened to carry", () => {
    const line = statusLineFor(["export API_KEY=abcdefghijklmnop"]);
    expect(line.text).not.toContain("abcdefghijklmnop");
  });

  it("is a status line every screen already shows while live, and an ordinary step once folded", () => {
    const live = liveStatusTool({ text: "Still on it: running the tests", words: "running the tests" });
    expect(live).toEqual({ name: "notice: Still on it: running the tests", ok: true, statusLine: "live", spoken: "running the tests" });
    expect(foldedStatusTool({ text: "Still on it: running the tests", words: "running the tests" }))
      .toEqual({ name: "Still on it: running the tests", ok: true, statusLine: "folded", spoken: "running the tests" });
    expect(liveStatusTool({ text: "Still on it" })).toEqual({ name: "notice: Still on it", ok: true, statusLine: "live" });
  });
});

describe("what counts as the dog speaking to the person", () => {
  const bot = (message: Partial<WireMessage>) => ({ id: "x", at: 0, role: "bot", kind: "text", ...message }) as WireMessage;

  it("counts replies, cards, notices and failures, but not tool steps or the dog's own status line", () => {
    expect(speaksToPerson(bot({ text: "Found it." }))).toBe(true);
    expect(speaksToPerson(bot({ text: "  " }))).toBe(false);
    expect(speaksToPerson(bot({ role: "user", text: "well?" }))).toBe(true);
    expect(speaksToPerson(bot({ kind: "options", card: { title: "Approval needed", options: [] } as never }))).toBe(true);
    expect(speaksToPerson(bot({ kind: "activity", tool: { name: "notice: switched account", ok: true } }))).toBe(true);
    expect(speaksToPerson(bot({ kind: "activity", tool: { name: "error: no activity", ok: false } }))).toBe(true);
    expect(speaksToPerson(bot({ kind: "activity", tool: { name: "Bash", spoken: "running a few commands" } }))).toBe(false);
    expect(speaksToPerson(bot({ kind: "activity", tool: liveStatusTool({ text: "Still on it" }) }))).toBe(false);
    expect(speaksToPerson(bot({ kind: "screen" }))).toBe(false);
  });
});

describe("a quiet status line while a dog works", () => {
  it("says nothing during the first few quiet minutes", () => {
    const { lines, step, advance, statusLines } = fixture();
    lines.begin(THREAD, "turn-1");
    step("running the tests");
    advance(STATUS_LINE_QUIET_MS - 1);
    expect(statusLines()).toHaveLength(0);
  });

  it("posts one plain line from the latest step once the dog has been quiet a while", () => {
    const { lines, step, advance, statusLines, ledger } = fixture();
    lines.begin(THREAD, "turn-1");
    step("doing some reading");
    step("run the focused tests");
    advance(STATUS_LINE_QUIET_MS);
    expect(statusLines()).toEqual([expect.objectContaining({
      role: "bot", kind: "activity", turnId: "turn-1",
      tool: { name: "notice: Still on it: running the focused tests", ok: true, statusLine: "live", spoken: "running the focused tests" },
    })]);
    expect(ledger()).toEqual([{ threadId: THREAD, messageId: statusLines()[0]!.id, text: "Still on it: running the focused tests", words: "running the focused tests" }]);
  });

  it("updates the same line in place, at most every few minutes and only when the words change", () => {
    const { lines, step, advance, statusLines, patches } = fixture();
    lines.begin(THREAD, "turn-1");
    step("running the tests");
    advance(STATUS_LINE_QUIET_MS);
    const first = statusLines()[0]!.id;
    step("making edits");
    advance(STATUS_LINE_EVERY_MS - 1);
    expect(patches).toHaveLength(0);
    advance(1);
    expect(statusLines()).toHaveLength(1);
    expect(statusLines()[0]).toMatchObject({ id: first, tool: { name: "notice: Still on it: making edits", statusLine: "live" } });
    advance(STATUS_LINE_EVERY_MS * 4);
    expect(patches).toHaveLength(1);
  });

  it("folds the line into the turn's progress when the dog speaks, then starts a fresh quiet stretch", () => {
    const { lines, post, step, advance, statusLines, ledger } = fixture();
    lines.begin(THREAD, "turn-1");
    step("running the tests");
    advance(STATUS_LINE_QUIET_MS);
    post({ role: "bot", kind: "text", turnId: "turn-1", text: "The tests pass; fixing the build next." });
    expect(statusLines()).toEqual([expect.objectContaining({ tool: foldedStatusTool({ text: "Still on it: running the tests", words: "running the tests" }) })]);
    expect(ledger()).toEqual([]);
    step("building the app");
    advance(STATUS_LINE_QUIET_MS - 1);
    expect(statusLines()).toHaveLength(1);
    advance(1);
    expect(statusLines()).toHaveLength(2);
    expect(statusLines()[1]!.tool).toMatchObject({ name: "notice: Still on it: building the app", statusLine: "live" });
  });

  it("folds the line when the turn ends", () => {
    const { lines, step, advance, statusLines } = fixture();
    lines.begin(THREAD, "turn-1");
    step("running the tests");
    advance(STATUS_LINE_QUIET_MS);
    lines.settle(THREAD);
    expect(statusLines()[0]!.tool?.statusLine).toBe("folded");
    advance(STATUS_LINE_QUIET_MS * 2);
    expect(statusLines()).toHaveLength(1);
  });

  it("folds the line when the dog stops working without a turn end", () => {
    const { lines, step, advance, statusLines, work } = fixture();
    lines.begin(THREAD, "turn-1");
    step("running the tests");
    advance(STATUS_LINE_QUIET_MS);
    work.set(THREAD, "idle");
    advance(1);
    expect(statusLines()[0]!.tool?.statusLine).toBe("folded");
    expect(lines.open(THREAD)).toBeNull();
  });

  it("stays silent while the dog waits on the person, and restarts the quiet clock after", () => {
    const { lines, step, advance, statusLines, work } = fixture();
    lines.begin(THREAD, "turn-1");
    step("running the tests");
    work.set(THREAD, "waiting");
    advance(STATUS_LINE_QUIET_MS * 5);
    expect(statusLines()).toHaveLength(0);
    work.set(THREAD, "working");
    advance(STATUS_LINE_QUIET_MS - 1);
    expect(statusLines()).toHaveLength(0);
    advance(1);
    expect(statusLines()).toHaveLength(1);
  });

  it("picks up a thread whose turn start it missed, from its first step", () => {
    const { step, advance, statusLines } = fixture();
    step("making edits");
    advance(STATUS_LINE_QUIET_MS);
    expect(statusLines()).toHaveLength(1);
  });

  it("ignores threads where no dog is working", () => {
    const { step, advance, statusLines, work } = fixture();
    work.set(THREAD, "idle");
    step("making edits");
    advance(STATUS_LINE_QUIET_MS);
    expect(statusLines()).toHaveLength(0);
  });

  it("says just 'Still on it' when no step had words worth repeating", () => {
    const { lines, advance, statusLines } = fixture();
    lines.begin(THREAD, "turn-1");
    advance(STATUS_LINE_QUIET_MS);
    expect(statusLines()[0]!.tool).toEqual({ name: "notice: Still on it", ok: true, statusLine: "live" });
  });

  it("keeps the live line in the thread's state and says each time it changes, so the phone sees it too", () => {
    const changes: string[] = [];
    const { lines, step, advance, post } = fixture({ changed: (threadId) => changes.push(threadId) });
    lines.begin(THREAD, "turn-1");
    step("running the tests");
    expect(lines.current(THREAD)).toBeUndefined();
    advance(STATUS_LINE_QUIET_MS);
    expect(lines.current(THREAD)).toBe("Still on it: running the tests");
    expect(changes).toEqual([THREAD]);
    step("making edits");
    advance(STATUS_LINE_EVERY_MS);
    expect(lines.current(THREAD)).toBe("Still on it: making edits");
    expect(changes).toEqual([THREAD, THREAD]);
    post({ role: "bot", kind: "text", turnId: "turn-1", text: "All green." });
    expect(lines.current(THREAD)).toBeUndefined();
    expect(changes).toEqual([THREAD, THREAD, THREAD]);
  });

  it("keeps going when sharing a change fails", () => {
    const { lines, step, advance, statusLines } = fixture({ changed: () => { throw new Error("no clients"); } });
    lines.begin(THREAD, "turn-1");
    step("running the tests");
    advance(STATUS_LINE_QUIET_MS);
    expect(statusLines()).toHaveLength(1);
    lines.settle(THREAD);
    expect(statusLines()[0]!.tool?.statusLine).toBe("folded");
  });

  it("folds a line left open when the server stopped mid-turn", () => {
    const open = { threadId: THREAD, messageId: "m-old", text: "Still on it: running the tests", words: "running the tests" };
    const { lines, messages, ledger } = fixture({ ledger: [open] });
    messages.push({ id: "m-old", at: 1, role: "bot", kind: "activity", tool: liveStatusTool(open) });
    expect(lines.foldLeftovers()).toBe(1);
    expect(messages[0]!.tool).toEqual(foldedStatusTool(open));
    expect(ledger()).toEqual([]);
  });
});

describe("when a dog counts as working", () => {
  const sources = (activity: string | undefined, group = false) => ({
    botByThread: (threadId: string) => (threadId === "gone" ? null : { id: "b1" }),
    groupByThread: () => (group ? { id: "g1" } : undefined),
    taskByThread: () => (activity === undefined ? undefined : { activity }),
  });
  const quiet = () => ({ waitingOnHuman: false, waitingOnComputer: false });

  it("is working only on a dog's own thread that is busy and not waiting on anyone", () => {
    expect(threadWork(sources("working"), quiet)(THREAD)).toBe("working");
    expect(threadWork(sources("working"), () => undefined)(THREAD)).toBe("working");
    expect(threadWork(sources("waiting-on-you"), quiet)(THREAD)).toBe("waiting");
    expect(threadWork(sources("working"), () => ({ waitingOnHuman: true, waitingOnComputer: false }))(THREAD)).toBe("waiting");
    expect(threadWork(sources("working"), () => ({ waitingOnHuman: false, waitingOnComputer: true }))(THREAD)).toBe("waiting");
    expect(threadWork(sources("idle"), quiet)(THREAD)).toBe("idle");
    expect(threadWork(sources(undefined), quiet)(THREAD)).toBe("idle");
    expect(threadWork(sources("working"), quiet)("gone")).toBe("idle");
    expect(threadWork(sources("working", true), quiet)(THREAD)).toBe("idle");
  });
});

describe("where open lines are remembered", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("round-trips through a small file and tolerates a missing or damaged one", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-lines-"));
    dirs.push(dir);
    const path = join(dir, "status-lines.json");
    const ledger = fileStatusLineLedger(path);
    expect(ledger.read()).toEqual([]);
    ledger.write([{ threadId: "t", messageId: "m", text: "Still on it" }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([{ threadId: "t", messageId: "m", text: "Still on it" }]);
    expect(ledger.read()).toEqual([{ threadId: "t", messageId: "m", text: "Still on it" }]);
    writeFileSync(path, "[{\"threadId\":1}, {\"threadId\":\"t\",\"messageId\":\"m\",\"text\":\"x\"}]");
    expect(ledger.read()).toEqual([{ threadId: "t", messageId: "m", text: "x" }]);
    writeFileSync(path, "not json");
    expect(ledger.read()).toEqual([]);
  });
});

describe("timing", () => {
  it("defaults to a few minutes and accepts faster timings for fixtures", () => {
    expect(statusLineTimingFromEnv({})).toEqual({ quietMs: STATUS_LINE_QUIET_MS, everyMs: STATUS_LINE_EVERY_MS, checkMs: 30_000 });
    expect(statusLineTimingFromEnv({ LATERDOG_STATUS_LINE_QUIET_MS: "1500", LATERDOG_STATUS_LINE_EVERY_MS: "2000", LATERDOG_STATUS_LINE_CHECK_MS: "200" }))
      .toEqual({ quietMs: 1_500, everyMs: 2_000, checkMs: 200 });
    expect(statusLineTimingFromEnv({ LATERDOG_STATUS_LINE_QUIET_MS: "5", LATERDOG_STATUS_LINE_CHECK_MS: "nope" }))
      .toEqual({ quietMs: 1_000, everyMs: STATUS_LINE_EVERY_MS, checkMs: 30_000 });
  });
});
