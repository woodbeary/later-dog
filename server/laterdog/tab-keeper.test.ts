import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPersonTab, type Target } from "./cloud-tabs.ts";
import { UPKEEP_REPORT } from "./computer-upkeep.ts";
import type { ThreadState } from "./process-reaper.ts";
import { TabKeeper, type TabKeeperDeps, type TabListing } from "./tab-keeper.ts";

const HOUR = 60 * 60 * 1000;
const A = { botId: "dog", threadId: "a" };
const B = { botId: "dog", threadId: "b" };

class Computer {
  tabs: Target[] = [{ id: "START000", url: "about:blank" }];
  browserUp = true;
  asleep = false;
  stubborn = new Set<string>();
  commands: string[] = [];
  private next = 1;

  list(): Target[] | null { return this.browserUp ? this.tabs.map((tab) => ({ ...tab })) : null; }
  open(url: string): string {
    const id = `TAB${String(this.next++).padStart(5, "0")}`;
    this.tabs.unshift({ id, url });
    return id;
  }
  navigate(id: string, url: string): void {
    const tab = this.tabs.find((each) => each.id === id)!;
    tab.url = url;
    this.tabs = [tab, ...this.tabs.filter((each) => each !== tab)];
  }
  async run(command: string): Promise<{ ok: boolean; stdout: string } | null> {
    this.commands.push(command);
    if (this.asleep) return { ok: false, stdout: "" };
    for (const [, id] of command.matchAll(/\/json\/close\/([A-Za-z0-9]+)/g)) if (!this.stubborn.has(id!)) this.tabs = this.tabs.filter((tab) => tab.id !== id);
    let stdout = command.includes("/json/list") && this.browserUp ? JSON.stringify(this.tabs.map((tab) => ({ ...tab, type: "page" }))) : "";
    if (command.includes(`${UPKEEP_REPORT}-start`)) stdout += `\n${UPKEEP_REPORT}-start\n${UPKEEP_REPORT} freed_kb=2048 stopped=1\n`;
    return { ok: true, stdout };
  }
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: Partial<TabKeeperDeps> & { busy?: Set<string>; held?: { value: boolean }; epoch?: { value: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tab-keeper-"));
  dirs.push(dir);
  const computer = new Computer();
  const busy = options.busy ?? new Set<string>();
  const held = options.held ?? { value: false };
  const epoch = options.epoch ?? { value: 0 };
  let clock = 1_000 * HOUR;
  const keeper = new TabKeeper({
    file: join(dir, "cloud-tabs.json"),
    run: (_boxId, command) => computer.run(command),
    thread: (_botId, threadId): ThreadState => ({ exists: true, busy: busy.has(threadId), closed: false, lastActiveAt: clock - HOUR }),
    control: () => ({ held: held.value, epoch: epoch.value }),
    now: () => (clock += 1_000),
    settleMs: 0,
    ...options,
  });
  const call = (owner: typeof A, act: () => string | void, keep = false) => {
    const before = computer.list();
    const opened = act();
    const watch = keeper.watch(owner, "box");
    const doomed = watch.seen({ before, after: computer.list() } satisfies TabListing, opened ? { id: opened, keep } : null);
    if (doomed.length) {
      for (const id of doomed) computer.tabs = computer.tabs.filter((tab) => tab.id !== id);
      watch.closed(computer.list());
    }
    return doomed;
  };
  const openReusing = (owner: typeof A, url: string, keep = false) => call(owner, () => {
    const choice = keeper.watch(owner, "box").choose();
    const target = choice.target && computer.tabs.some((tab) => tab.id === choice.target) ? choice.target : undefined;
    if (target) { computer.navigate(target, url); return target; }
    const front = computer.tabs[0];
    if (front && front.url === "about:blank" && !choice.avoid.includes(front.id)) { computer.navigate(front.id, url); return front.id; }
    return computer.open(url);
  }, keep);
  return { keeper, computer, busy, held, epoch, call, openReusing };
}

describe("a dog's turn on its cloud computer", () => {
  it("leaves only the page on screen once a turn that opened five tabs ends, and nothing changes while the turn runs", async () => {
    const { keeper, computer, busy, call } = setup();
    busy.add("a");
    for (const n of [1, 2, 3, 4, 5]) call(A, () => computer.open(`https://site.test/${n}`));
    expect(computer.tabs).toHaveLength(4);
    expect(await keeper.turnEnded("a")).toEqual({ closed: 0, freedBytes: 0, stopped: 0 });
    expect(computer.tabs).toHaveLength(4);
    busy.delete("a");
    const done = await keeper.turnEnded("a");
    expect(done.closed).toBe(3);
    expect(computer.tabs.map((tab) => tab.url)).toEqual(["https://site.test/5"]);
  });

  it("opens a five-page task in one tab and leaves that one tab when the turn ends", async () => {
    const { keeper, computer, openReusing } = setup();
    for (const n of [1, 2, 3, 4, 5]) openReusing(A, `https://site.test/${n}`);
    expect(computer.tabs).toEqual([{ id: "START000", url: "https://site.test/5" }]);
    await keeper.turnEnded("a");
    expect(computer.tabs).toEqual([{ id: "START000", url: "https://site.test/5" }]);
  });

  it("holds the cap after every call, closing the oldest idle tab the dog opened first", () => {
    const { computer, call } = setup();
    const closed: string[][] = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      closed.push(call(A, () => computer.open(`https://site.test/${n}`)));
      expect(computer.tabs.length).toBeLessThanOrEqual(4);
    }
    expect(closed.flat()).toEqual(["START000", "TAB00001", "TAB00002", "TAB00003"]);
    expect(computer.tabs.map((tab) => tab.url)).toEqual(["https://site.test/7", "https://site.test/6", "https://site.test/5", "https://site.test/4"]);
  });

  it("keeps a page the dog was told to leave open, and the tab the person opened while they had control", async () => {
    const { keeper, computer, epoch, call, openReusing } = setup();
    openReusing(A, "https://keep.test/", true);
    call(A, () => computer.open("https://extra.test/"));
    epoch.value += 2;
    computer.open("https://person.test/");
    call(A, () => computer.open("https://last.test/"));
    expect(computer.tabs).toHaveLength(4);
    await keeper.turnEnded("a");
    expect(computer.tabs.map((tab) => tab.url).sort()).toEqual(["https://keep.test/", "https://last.test/", "https://person.test/"]);
    expect(isPersonTab(Object.values(keeper.ledger.box!.tabs).find((tab) => tab.url === "https://person.test/")!)).toBe(true);
    for (let n = 0; n < 6; n++) call(A, () => computer.open(`https://more.test/${n}`));
    expect(computer.tabs.map((tab) => tab.url)).toEqual(expect.arrayContaining(["https://keep.test/", "https://person.test/"]));
  });

  it("closes nothing while the person has control or an open request for help, and catches up once they hand it back", async () => {
    const { keeper, computer, held, call } = setup();
    for (const n of [1, 2, 3]) call(A, () => computer.open(`https://site.test/${n}`));
    held.value = true;
    computer.commands.length = 0;
    expect((await keeper.turnEnded("a")).closed).toBe(0);
    expect(await keeper.sweep()).toBe(0);
    expect(computer.commands).toEqual([]);
    expect(computer.tabs).toHaveLength(4);
    held.value = false;
    expect(await keeper.sweep()).toBe(3);
    expect(computer.tabs.map((tab) => tab.url)).toEqual(["https://site.test/3"]);
  });

  it("runs nothing on a computer the finished turn did not use, so an idle computer still goes to sleep", async () => {
    const { keeper, computer, call } = setup();
    call(A, () => computer.open("https://site.test/1"));
    await keeper.turnEnded("a");
    computer.commands.length = 0;
    await keeper.turnEnded("a");
    await keeper.turnEnded("b");
    expect(await keeper.sweep()).toBe(0);
    expect(computer.commands).toEqual([]);
  });

  it("waits for the finished turn to settle before it tidies, instead of giving up while the turn is still wrapping up", async () => {
    const { keeper, computer, busy, call } = setup({ settleMs: 5_000 });
    for (const n of [1, 2]) call(A, () => computer.open(`https://site.test/${n}`));
    busy.add("a");
    setTimeout(() => busy.delete("a"), 400);
    const started = Date.now();
    expect((await keeper.turnEnded("a")).closed).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(computer.tabs.map((tab) => tab.url)).toEqual(["https://site.test/2"]);
  });

  it("tries again at the next turn end when the computer was asleep or the task was already busy again", async () => {
    const { keeper, computer, busy, call } = setup();
    for (const n of [1, 2]) call(A, () => computer.open(`https://site.test/${n}`));
    computer.asleep = true;
    expect((await keeper.turnEnded("a")).closed).toBe(0);
    computer.asleep = false;
    busy.add("a");
    expect((await keeper.turnEnded("a")).closed).toBe(0);
    busy.delete("a");
    expect((await keeper.turnEnded("a")).closed).toBe(2);
  });

  it("stops trying a tab that would not close instead of waking the computer every sweep", async () => {
    const { keeper, computer, call } = setup();
    call(A, () => computer.open("https://site.test/1"));
    call(A, () => computer.open("https://site.test/2"));
    computer.stubborn.add("TAB00001");
    computer.stubborn.add("START000");
    await keeper.turnEnded("a");
    computer.commands.length = 0;
    expect(await keeper.sweep()).toBe(0);
    expect(computer.commands).toEqual([]);
  });

  it("forgets what a closed browser held and leaves a computer without a running browser alone", async () => {
    const { keeper, computer, call } = setup();
    call(A, () => computer.open("https://site.test/1"));
    computer.browserUp = false;
    expect((await keeper.turnEnded("a")).closed).toBe(0);
    computer.commands.length = 0;
    expect(await keeper.sweep()).toBe(0);
    expect(computer.commands).toEqual([]);
  });

  it("tidies the machine in the same command as the turn-end listing, only where told to", async () => {
    const withUpkeep = setup({ upkeep: () => "echo upkeep" });
    withUpkeep.call(A, () => withUpkeep.computer.open("https://site.test/1"));
    expect(await withUpkeep.keeper.turnEnded("a")).toEqual({ closed: 1, freedBytes: 2048 * 1024, stopped: 1 });
    expect(withUpkeep.computer.commands.filter((command) => command.includes("echo upkeep"))).toHaveLength(1);
    const without = setup();
    without.call(A, () => without.computer.open("https://site.test/1"));
    expect(await without.keeper.turnEnded("a")).toEqual({ closed: 1, freedBytes: 0, stopped: 0 });
  });

  it("sends nothing at the end of a turn that only looked at the screen, so the computer is left alone", async () => {
    const { keeper, computer } = setup({ upkeep: () => "echo upkeep" });
    for (const tool of ["screenshot", "zoom", "get_screen_size", "move", "scroll", "page_read", "page_text"]) keeper.watch(A, "box", tool);
    expect(await keeper.turnEnded("a")).toEqual({ closed: 0, freedBytes: 0, stopped: 0 });
    expect(computer.commands).toEqual([]);
    expect(keeper.ledger).toEqual({});
    keeper.watch(A, "box", "exec");
    expect((await keeper.turnEnded("a")).freedBytes).toBe(2048 * 1024);
    expect(computer.commands).toHaveLength(1);
  });

  it("runs the end-of-turn upkeep after a turn that only ran commands, on a computer it never listed before", async () => {
    const { keeper, computer } = setup({ upkeep: () => "echo upkeep" });
    keeper.watch(A, "box");
    expect(await keeper.turnEnded("a")).toEqual({ closed: 0, freedBytes: 2048 * 1024, stopped: 1 });
    expect(computer.commands.filter((command) => command.includes("echo upkeep"))).toHaveLength(1);
    expect(keeper.ledger.box!.users).toEqual({ "dog/a": A });
    expect(computer.tabs).toHaveLength(1);
  });

  it("lets another task reuse the idle tab on screen instead of opening its own", async () => {
    const { keeper, computer, openReusing } = setup();
    openReusing(A, "https://a.test/");
    await keeper.turnEnded("a");
    openReusing(B, "https://b.test/");
    expect(computer.tabs).toEqual([{ id: "START000", url: "https://b.test/" }]);
    expect(keeper.ledger.box!.tabs.START000).toMatchObject({ threadId: "b" });
  });

  it("closes the tabs of a turn whose end it missed at the next sweep, after a restart", async () => {
    const first = setup();
    first.call(A, () => first.computer.open("https://site.test/1"));
    first.call(A, () => first.computer.open("https://site.test/2"));
    const restarted = new TabKeeper({
      file: join(dirs.at(-1)!, "cloud-tabs.json"),
      run: (_boxId, command) => first.computer.run(command),
      thread: (): ThreadState => ({ exists: true, busy: false, closed: false, lastActiveAt: Date.now() }),
      control: () => ({ held: false, epoch: 0 }),
    });
    expect(await restarted.turnEnded("a")).toEqual({ closed: 0, freedBytes: 0, stopped: 0 });
    expect(await restarted.sweep()).toBe(2);
    expect(first.computer.tabs.map((tab) => tab.url)).toEqual(["https://site.test/2"]);
  });
});
