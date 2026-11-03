import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeTabsScript, forgetUsers, loadTabLedger, parseTargets, recordTabs, saveTabLedger, splitTabListing, tabCloseReason, tabsToClose,
  TABS_MARKER, withTabListing, type TabLedger,
} from "./cloud-tabs.ts";
import type { ThreadState } from "./process-reaper.ts";

const HOUR = 60 * 60 * 1000;
const now = 1_000 * HOUR;
const A = { botId: "dog", threadId: "a" };
const B = { botId: "dog", threadId: "b" };
const live: ThreadState = { exists: true, busy: false, closed: false, lastActiveAt: now - HOUR };
const page = (id: string, url: string) => ({ id, url });

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

  it("splits the listing off a command's own output and keeps the exit code", () => {
    const wrapped = withTabListing("xdotool click 1");
    expect(wrapped.startsWith("xdotool click 1\n")).toBe(true);
    expect(wrapped).toContain("exit $__laterdog_rc");
    expect(splitTabListing(`out\n\n${TABS_MARKER}\n[]`)).toEqual({ stdout: "out\n", targets: [] });
    expect(splitTabListing(`\n${TABS_MARKER}\n`)).toEqual({ stdout: "", targets: null });
    expect(splitTabListing("plain")).toEqual({ stdout: "plain", targets: null });
  });
});

describe("who owns a tab", () => {
  it("gives a new tab to the task that was working, and the focused tab to whoever uses it", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/")], now);
    recordTabs(ledger, "box", B, [page("T2", "https://b.test/"), page("T1", "https://a.test/")], now);
    expect(ledger.box!.tabs.T1!.threadId).toBe("a");
    expect(ledger.box!.tabs.T2!.threadId).toBe("b");
    recordTabs(ledger, "box", B, [page("T1", "https://a.test/"), page("T2", "https://b.test/")], now);
    expect(ledger.box!.tabs.T1!.threadId).toBe("b");
    expect(ledger.box!.focused).toBe("T1");
  });

  it("forgets closed tabs, and follows tabs the browser restores with new ids after the computer sleeps", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/"), page("T2", "https://gone.test/")], now);
    recordTabs(ledger, "box", null, [page("N1", "https://a.test/")], now);
    expect(Object.keys(ledger.box!.tabs)).toEqual(["N1"]);
    expect(ledger.box!.tabs.N1!.threadId).toBe("a");
  });

  it("never claims tabs it has no owner for", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", null, [page("P1", "https://person.test/")], now);
    expect(ledger.box!.tabs).toEqual({});
  });
});

describe("which tabs close", () => {
  it("closes a finished, deleted or 6-hour idle task's tabs, never a working one's", () => {
    expect(tabCloseReason({ ...live, closed: true }, now)).toBe("task closed");
    expect(tabCloseReason({ exists: false, busy: false, closed: false, lastActiveAt: null }, now)).toBe("task gone");
    expect(tabCloseReason({ ...live, lastActiveAt: now - 7 * HOUR }, now)).toBe("task idle");
    expect(tabCloseReason({ ...live, lastActiveAt: now - 5 * HOUR }, now)).toBeNull();
    expect(tabCloseReason({ ...live, busy: true, closed: true }, now)).toBeNull();
  });

  it("keeps the tab on screen while another task is working on that computer", () => {
    const ledger: TabLedger = {};
    recordTabs(ledger, "box", A, [page("T1", "https://a.test/"), page("T2", "https://a2.test/")], now);
    recordTabs(ledger, "box", B, [page("T1", "https://a.test/"), page("T2", "https://a2.test/")], now);
    ledger.box!.tabs.T1!.threadId = "a";
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
});
