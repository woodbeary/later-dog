import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeTabsScript, forgetUsers, isDogTab, isPersonTab, loadTabLedger, MAX_TABS_PER_COMPUTER, parseTargets, recordTabs, saveTabLedger, splitTabListing,
  tabCloseReason, tabsAfterTurn, tabsOverCap, tabsToClose, tabToReuse, TABS_BEFORE_MARKER, TABS_MARKER, withTabListing, type DogTab, type TabLedger,
} from "./cloud-tabs.ts";
import type { ThreadState } from "./process-reaper.ts";

const HOUR = 60 * 60 * 1000;
const now = 1_000 * HOUR;
const A = { botId: "dog", threadId: "a" };
const B = { botId: "dog", threadId: "b" };
const live: ThreadState = { exists: true, busy: false, closed: false, lastActiveAt: now - HOUR };
const page = (id: string, url: string) => ({ id, url });
const resting = (): ThreadState => live;
const reuse = (...args: Parameters<typeof tabToReuse>) => {
  const choice = tabToReuse(...args);
  return { ...choice, avoid: [...choice.avoid].sort() };
};

describe("reading the browser's tabs", () => {
  it("keeps only real pages", () => {
    const text = JSON.stringify([
      { id: "AAAA1111", type: "page", url: "https://a.test/" },
      { id: "BBBB2222", type: "browser_ui", url: "chrome://omnibox-popup.top-chrome/" },
      { id: "bad id!", type: "page", url: "https://b.test/" },
    ]);
    expect(parseTargets(text)).toEqual([page("AAAA1111", "https://a.test/")]);
    expect(parseTargets("")).toBeNull();
    expect(parseTargets("{}")).toBeNull();
    expect(parseTargets(`${text}\u001b[3J\u001b[H\u001b[2J`)).toEqual([page("AAAA1111", "https://a.test/")]);
  });

  it("lists the tabs before and after a command, splits both off its own output and keeps its exit code", () => {
    const wrapped = withTabListing("xdotool click 1");
    expect(wrapped.indexOf("/json/list")).toBeLessThan(wrapped.indexOf("xdotool click 1"));
    expect(wrapped.lastIndexOf("/json/list")).toBeGreaterThan(wrapped.indexOf("xdotool click 1"));
    expect(wrapped).toContain("\nxdotool click 1\n");
    expect(wrapped).toContain("exit $__laterdog_rc");
    const before = JSON.stringify([{ id: "AAAA1111", type: "page", url: "https://a.test/" }]);
    const after = JSON.stringify([{ id: "BBBB2222", type: "page", url: "https://b.test/" }, { id: "AAAA1111", type: "page", url: "https://a.test/" }]);
    expect(splitTabListing(`${before}\n${TABS_BEFORE_MARKER}\nout\n\n${TABS_MARKER}\n${after}`)).toEqual({
      stdout: "out\n", before: [page("AAAA1111", "https://a.test/")], targets: [page("BBBB2222", "https://b.test/"), page("AAAA1111", "https://a.test/")],
    });
    expect(splitTabListing(`\n${TABS_BEFORE_MARKER}\n\n${TABS_MARKER}\n`)).toEqual({ stdout: "", before: null, targets: null });
    expect(splitTabListing(`out\n\n${TABS_MARKER}\n[]`)).toEqual({ stdout: "out\n", before: null, targets: [] });
    expect(splitTabListing("plain")).toEqual({ stdout: "plain", before: null, targets: null });
  });
});

describe("who owns a tab", () => {
  it("gives a new tab to the task that was working, and the focused tab to whoever uses it", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/")], now);
    recordTabs(ledger, "box", B, [page("T2", "https://b.test/"), page("T1", "https://a.test/")], now);
    expect((ledger.box!.tabs.T1 as DogTab).threadId).toBe("a");
    expect((ledger.box!.tabs.T2 as DogTab).threadId).toBe("b");
    recordTabs(ledger, "box", B, [page("T1", "https://a.test/"), page("T2", "https://b.test/")], now);
    expect((ledger.box!.tabs.T1 as DogTab).threadId).toBe("b");
    expect(ledger.box!.focused).toBe("T1");
  });

  it("forgets closed tabs, and follows tabs the browser restores with new ids after the computer sleeps", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/"), page("T2", "https://gone.test/")], now);
    recordTabs(ledger, "box", null, [page("N1", "https://a.test/")], now);
    expect(Object.keys(ledger.box!.tabs)).toEqual(["N1"]);
    expect((ledger.box!.tabs.N1 as DogTab).threadId).toBe("a");
  });

  it("gives a page a dog opens during its call to the dog, even when a tab closed in that call had the same address", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", null, [page("P1", "https://shared.test/"), page("T1", "https://a.test/")], now, { person: true });
    const before = [page("P1", "https://shared.test/"), page("T1", "https://a.test/")];
    recordTabs(ledger, "box", A, [page("N1", "https://shared.test/"), page("T1", "https://a.test/")], now, { before });
    expect((ledger.box!.tabs.N1 as DogTab).threadId).toBe("a");
  });

  it("still follows restored tabs by address when the browser started during the call", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/")], now);
    (ledger.box!.tabs.T1 as DogTab).keep = true;
    recordTabs(ledger, "box", B, [page("N2", "https://new.test/"), page("N1", "https://a.test/")], now, { before: null });
    expect(ledger.box!.tabs.N1).toMatchObject({ threadId: "a", keep: true });
    expect((ledger.box!.tabs.N2 as DogTab).threadId).toBe("b");
  });

  it("records a tab no dog was seen opening as nobody's, never as a dog's", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", null, [page("P1", "https://person.test/")], now);
    expect(ledger.box!.tabs.P1).toEqual({ url: "https://person.test/", openedAt: now });
    expect(isDogTab(ledger.box!.tabs.P1!)).toBe(false);
  });

  it("gives a dog the tabs its own call opened, and the person the tabs that appeared while they had control", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/")], now);
    const before = [page("P1", "https://person.test/"), page("T1", "https://a.test/")];
    recordTabs(ledger, "box", A, [page("T2", "https://popup.test/"), ...before], now, { before, person: true });
    expect(isPersonTab(ledger.box!.tabs.P1!)).toBe(true);
    expect((ledger.box!.tabs.T2 as DogTab).threadId).toBe("a");
    recordTabs(ledger, "box", A, [page("P1", "https://person.test/"), page("T2", "https://popup.test/"), page("T1", "https://a.test/")], now);
    expect(isPersonTab(ledger.box!.tabs.P1!)).toBe(true);
  });

  it("gives a dog a tab that appeared between its calls when nobody else had control, such as one a command opened", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/")], now);
    const before = [page("X1", "https://from-a-command.test/"), page("T1", "https://a.test/")];
    recordTabs(ledger, "box", A, before, now, { before, person: false });
    expect((ledger.box!.tabs.X1 as DogTab).threadId).toBe("a");
  });

  it("makes the tab a page was opened in the dog's current tab, and keeps it when the dog was asked to", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/"), page("T0", "about:blank")], now - HOUR);
    recordTabs(ledger, "box", A, [page("T2", "https://keep.test/"), page("T1", "https://a.test/"), page("T0", "about:blank")], now, { opened: { id: "T2", keep: true } });
    expect(ledger.box!.tabs.T2).toMatchObject({ botId: "dog", threadId: "a", usedAt: now, keep: true });
    recordTabs(ledger, "box", B, [page("T2", "https://keep.test/"), page("T1", "https://a.test/")], now);
    expect(ledger.box!.tabs.T2).toMatchObject({ threadId: "a", keep: true });
  });
});

describe("which tab a dog opens a page in", () => {
  it("reuses the dog's own latest tab, else an idle tab on screen, never a person's, a kept or a working task's tab", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("A1", "https://a.test/")], now - 2 * HOUR);
    recordTabs(ledger, "box", A, [page("A2", "https://a2.test/"), page("A1", "https://a.test/")], now - HOUR);
    expect(reuse(ledger.box, A, resting)).toEqual({ target: "A2", avoid: [] });
    expect(reuse(ledger.box, B, resting)).toEqual({ target: "A2", avoid: [] });
    const busyA = (_bot: string, thread: string): ThreadState => ({ ...live, busy: thread === "a" });
    expect(reuse(ledger.box, B, busyA)).toEqual({ avoid: ["A1", "A2"] });
    (ledger.box!.tabs.A2 as DogTab).keep = true;
    expect(reuse(ledger.box, A, resting)).toEqual({ target: "A1", avoid: ["A2"] });
    ledger.box!.tabs.A1 = { person: true, url: "https://person.test/", openedAt: now };
    expect(reuse(ledger.box, A, resting)).toEqual({ avoid: ["A1", "A2"] });
    expect(reuse(undefined, A, resting)).toEqual({ avoid: [] });
  });
});

describe("which tabs close", () => {
  it("closes a finished, deleted or 6-hour idle task's tabs, never a working one's, and a kept tab only with its task", () => {
    expect(tabCloseReason({ ...live, closed: true }, now)).toBe("task closed");
    expect(tabCloseReason({ exists: false, busy: false, closed: false, lastActiveAt: null }, now)).toBe("task gone");
    expect(tabCloseReason({ ...live, lastActiveAt: now - 7 * HOUR }, now)).toBe("task idle");
    expect(tabCloseReason({ ...live, lastActiveAt: now - 7 * HOUR }, now, 6, true)).toBeNull();
    expect(tabCloseReason({ ...live, lastActiveAt: now - 5 * HOUR }, now)).toBeNull();
    expect(tabCloseReason({ ...live, busy: true, closed: true }, now)).toBeNull();
  });

  it("closes every tab a turn opened when it ends, except the one on screen and the ones it was asked to keep", () => {
    const ledger: TabLedger = {};
    const pages = [page("T5", "https://5.test/"), page("T4", "https://4.test/"), page("T3", "https://3.test/"), page("T2", "https://2.test/"), page("T1", "https://1.test/")];
    recordTabs(ledger, "box", A, pages.slice(1), now - HOUR, { opened: { id: "T3", keep: true } });
    recordTabs(ledger, "box", null, [page("P1", "https://person.test/"), ...pages.slice(1)], now, { person: true });
    recordTabs(ledger, "box", A, [...pages, page("P1", "https://person.test/")], now);
    expect(tabsAfterTurn(ledger.box!, A).sort()).toEqual(["T1", "T2", "T4"]);
    expect(tabsAfterTurn(ledger.box!, B)).toEqual([]);
  });

  it("past the cap, closes the oldest idle tab the dog opened first, then tabs nobody opened, never the person's, a kept one or the one on screen", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", null, [page("F1", "https://found.test/")], now - 10 * HOUR);
    recordTabs(ledger, "box", null, [page("P1", "https://person.test/"), page("F1", "https://found.test/")], now - 9 * HOUR, { person: true });
    recordTabs(ledger, "box", A, [page("K1", "https://kept.test/"), page("P1", "https://person.test/"), page("F1", "https://found.test/")], now - 8 * HOUR, { opened: { id: "K1", keep: true } });
    const open: Array<{ id: string; url: string }> = [page("K1", "https://kept.test/"), page("P1", "https://person.test/"), page("F1", "https://found.test/")];
    for (const [hour, id] of [[7, "D1"], [6, "D2"], [5, "D3"]] as const) {
      open.unshift(page(id, `https://${id}.test/`));
      recordTabs(ledger, "box", A, [...open], now - hour * HOUR);
    }
    expect(Object.keys(ledger.box!.tabs)).toHaveLength(6);
    expect(ledger.box!.focused).toBe("D3");
    expect(tabsOverCap(ledger.box!, MAX_TABS_PER_COMPUTER)).toEqual(["D1", "D2"]);
    expect(tabsOverCap(ledger.box!, 3)).toEqual(["D1", "D2", "F1"]);
    expect(tabsOverCap(ledger.box!, 1)).toEqual(["D1", "D2", "F1"]);
    expect(tabsOverCap(ledger.box!, MAX_TABS_PER_COMPUTER, ["D1"])).toEqual(["D2"]);
  });

  it("in the sweep, closes the tabs of a task whose turn is over and whatever is past the cap, keeping the tab on screen", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("A1", "https://a1.test/")], now - 3 * HOUR);
    recordTabs(ledger, "box", A, [page("A2", "https://a2.test/"), page("A1", "https://a1.test/")], now - 2 * HOUR);
    const states = (busyA: boolean) => (_bot: string, thread: string): ThreadState => (thread === "a" ? { ...live, busy: busyA } : live);
    expect(tabsToClose(ledger.box!, states(true), now)).toEqual([]);
    expect(tabsToClose(ledger.box!, states(false), now)).toEqual([{ id: "A1", url: "https://a1.test/", reason: "turn over" }]);
  });

  it("keeps the tab on screen while another task is working on that computer", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/"), page("T2", "https://a2.test/")], now);
    recordTabs(ledger, "box", B, [page("T1", "https://a.test/"), page("T2", "https://a2.test/")], now);
    (ledger.box!.tabs.T1 as DogTab).threadId = "a";
    const states = (busyB: boolean) => (_bot: string, thread: string): ThreadState =>
      thread === "a" ? { ...live, closed: true } : { ...live, busy: busyB };
    expect(tabsToClose(ledger.box!, states(true), now).map((tab) => tab.id)).toEqual(["T2"]);
    expect(tabsToClose(ledger.box!, states(false), now).map((tab) => tab.id).sort()).toEqual(["T1", "T2"]);
  });

  it("closes only well-formed ids and lists what is left", () => {
    const script = closeTabsScript(["AAAA1111", "x; rm -rf /"]);
    expect(script).toContain("/json/close/AAAA1111");
    expect(script).not.toContain("rm -rf");
    expect(script).toContain("/json/list");
  });

  it("drops tasks that no longer exist from a computer's users", () => {
    const ledger: TabLedger = { box: { tabs: {}, users: { "dog/a": A, "dog/b": B } } };
    forgetUsers(ledger, (user) => user.threadId === "b");
    expect(Object.keys(ledger.box!.users)).toEqual(["dog/b"]);
  });
});

describe("keeping the ledger", () => {
  it("survives a restart and tolerates a missing or broken file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cloud-tabs-")), "cloud-tabs.json");
    expect(loadTabLedger(file)).toEqual({});
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/")], now);
    saveTabLedger(file, ledger);
    expect(loadTabLedger(file)).toEqual(ledger);
  });

  it("reads a ledger written before tabs had owners of other kinds", () => {
    const ledger: TabLedger = { box: { tabs: { T1: { botId: "dog", threadId: "a", url: "https://a.test/", openedAt: now } }, users: { "dog/a": A }, focused: "T1" } };
    recordTabs(ledger, "box", A, [page("T2", "https://b.test/"), page("T1", "https://a.test/")], now);
    expect(tabsAfterTurn(ledger.box!, A)).toEqual(["T1"]);
  });
});
