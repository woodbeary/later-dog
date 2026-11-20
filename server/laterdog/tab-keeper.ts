import {
  closeTabsScript, forgetTabs, forgetUsers, listTabsScript, loadTabLedger, MAX_TABS_PER_COMPUTER, noteBrowserDown, parseTargets, recordTabs,
  saveTabLedger, tabsAfterTurn, tabsOverCap, tabsToClose, tabToReuse, TURN_TIDY_TOOLS, type Opened, type Owner, type TabChoice, type TabCloseReason, type TabLedger, type Target,
} from "./cloud-tabs.ts";
import { readUpkeepReport, UPKEEP_REPORT } from "./computer-upkeep.ts";
import type { ThreadState } from "./process-reaper.ts";

export interface KeeperExec { ok: boolean; stdout: string }

export interface TabKeeperDeps {
  file: string;
  run(boxId: string, command: string): Promise<KeeperExec | null>;
  thread(botId: string, threadId: string): ThreadState;
  control(botId: string): { held: boolean; epoch: number };
  upkeep?(boxId: string): string | null;
  log?(line: string): void;
  now?(): number;
  cap?: number;
  settleMs?: number;
}

const SETTLE_MS = 60_000;
const SETTLE_POLL_MS = 250;

export interface TabListing { before: Target[] | null; after: Target[] | null }

export interface TabWatch {
  choose(): TabChoice;
  seen(listing: TabListing, opened?: Opened | null): string[];
  closed(after: Target[] | null): void;
}

export interface AfterTurn { closed: number; freedBytes: number; stopped: number }

export class TabKeeper {
  readonly ledger: TabLedger;
  readonly #deps: TabKeeperDeps;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #touched = new Map<string, Map<string, Owner>>();
  readonly #stuck = new Map<string, Set<string>>();
  #sweeping = false;

  constructor(deps: TabKeeperDeps) {
    this.#deps = deps;
    this.ledger = loadTabLedger(deps.file);
  }

  get #cap(): number { return this.#deps.cap ?? MAX_TABS_PER_COMPUTER; }
  #now(): number { return this.#deps.now?.() ?? Date.now(); }
  #save(): void { saveTabLedger(this.#deps.file, this.ledger); }

  #bots(boxId: string, also?: Owner): string[] {
    const users = Object.values(this.ledger[boxId]?.users ?? {}).map((user) => user.botId);
    return [...new Set(also ? [...users, also.botId] : users)];
  }

  #held(boxId: string, also?: Owner): boolean {
    return this.#bots(boxId, also).some((botId) => this.#deps.control(botId).held);
  }

  #touch(owner: Owner, boxId: string): void {
    const boxes = this.#touched.get(owner.threadId) ?? new Map<string, Owner>();
    boxes.set(boxId, owner);
    this.#touched.set(owner.threadId, boxes);
  }

  #controlChanged(boxId: string, also?: Owner): boolean {
    const before = this.ledger[boxId]?.control;
    if (!before) return false;
    return this.#bots(boxId, also).some((botId) => before[botId] !== undefined && before[botId] !== this.#deps.control(botId).epoch);
  }

  #rememberControl(boxId: string): void {
    const box = this.ledger[boxId];
    if (box) box.control = Object.fromEntries(this.#bots(boxId).map((botId) => [botId, this.#deps.control(botId).epoch]));
  }

  #record(boxId: string, owner: Owner | null, after: readonly Target[], options: { before?: Target[] | null; opened?: Opened | null; adopt?: Owner | null } = {}): void {
    const person = this.#controlChanged(boxId, owner ?? undefined);
    recordTabs(this.ledger, boxId, owner, after, this.#now(), { ...options, person });
    this.#rememberControl(boxId);
  }

  #queue<T>(boxId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.#queues.get(boxId) ?? Promise.resolve();
    const next = prior.then(task, task);
    const settled = next.then(() => undefined, () => undefined);
    this.#queues.set(boxId, settled);
    void settled.then(() => { if (this.#queues.get(boxId) === settled) this.#queues.delete(boxId); });
    return next;
  }

  watch(owner: Owner, boxId: string, tool?: string): TabWatch {
    if (tool === undefined || TURN_TIDY_TOOLS.has(tool)) this.#touch(owner, boxId);
    return {
      choose: () => tabToReuse(this.ledger[boxId], owner, this.#deps.thread),
      seen: ({ before, after }, opened) => {
        if (!after) {
          noteBrowserDown(this.ledger, boxId);
          this.#save();
          return [];
        }
        this.#record(boxId, owner, after, { before, opened });
        this.#stuck.delete(boxId);
        this.#save();
        const box = this.ledger[boxId];
        return box && !this.#held(boxId) ? tabsOverCap(box, this.#cap) : [];
      },
      closed: (after) => {
        if (after) this.#record(boxId, null, after, { adopt: null });
        else noteBrowserDown(this.ledger, boxId);
        this.#save();
      },
    };
  }

  async turnEnded(threadId: string): Promise<AfterTurn> {
    const boxes = this.#touched.get(threadId);
    const total: AfterTurn = { closed: 0, freedBytes: 0, stopped: 0 };
    if (!boxes) return total;
    this.#touched.delete(threadId);
    for (const [boxId, owner] of boxes) {
      await this.#settled(owner);
      const done = await this.#queue(boxId, () => this.#afterTurn(boxId, owner));
      if (!done) {
        const pending = this.#touched.get(threadId) ?? new Map<string, Owner>();
        if (!pending.has(boxId)) pending.set(boxId, owner);
        this.#touched.set(threadId, pending);
        continue;
      }
      total.closed += done.closed;
      total.freedBytes += done.freedBytes;
      total.stopped += done.stopped;
    }
    return total;
  }

  async #settled(owner: Owner): Promise<void> {
    const deadline = Date.now() + (this.#deps.settleMs ?? SETTLE_MS);
    while (this.#deps.thread(owner.botId, owner.threadId).busy && Date.now() < deadline) {
      await new Promise<void>((settle) => setTimeout(settle, SETTLE_POLL_MS).unref());
    }
  }

  async #afterTurn(boxId: string, owner: Owner): Promise<AfterTurn | null> {
    if (this.#deps.thread(owner.botId, owner.threadId).busy || this.#held(boxId, owner)) return null;
    const upkeep = this.#deps.upkeep?.(boxId) ?? null;
    const command = upkeep ? `${listTabsScript}; printf '\\n%s\\n' '${UPKEEP_REPORT}-start'\n${upkeep}` : listTabsScript;
    const listed = await this.#deps.run(boxId, command).catch(() => null);
    if (!listed || (!listed.ok && !listed.stdout.trim())) return null;
    const cut = listed.stdout.indexOf(`\n${UPKEEP_REPORT}-start\n`);
    const report = readUpkeepReport(cut === -1 ? "" : listed.stdout.slice(cut));
    const done: AfterTurn = { closed: 0, freedBytes: report?.freedBytes ?? 0, stopped: report?.stopped ?? 0 };
    const targets = parseTargets(cut === -1 ? listed.stdout : listed.stdout.slice(0, cut));
    if (!targets) {
      noteBrowserDown(this.ledger, boxId);
      this.#save();
      return done;
    }
    if (this.#deps.thread(owner.botId, owner.threadId).busy || this.#held(boxId, owner)) return done;
    this.#record(boxId, null, targets, { adopt: owner });
    const box = this.ledger[boxId];
    if (!box) return done;
    const finished = tabsAfterTurn(box, owner);
    const doomed = [...finished, ...tabsOverCap(box, this.#cap, finished)];
    if (!doomed.length) {
      this.#save();
      return done;
    }
    done.closed = await this.#close(boxId, doomed);
    if (done.closed) this.#deps.log?.(`[tabs] closed ${done.closed} tab(s) a finished turn left open on cloud computer ${boxId}`);
    return done;
  }

  async #close(boxId: string, ids: string[]): Promise<number> {
    const result = await this.#deps.run(boxId, closeTabsScript(ids)).catch(() => null);
    if (!result?.ok) {
      this.#save();
      return 0;
    }
    const after = parseTargets(result.stdout);
    if (!after) {
      forgetTabs(this.ledger, boxId, ids);
      noteBrowserDown(this.ledger, boxId);
      this.#save();
      return 0;
    }
    this.#record(boxId, null, after, { adopt: null });
    const left = new Set(after.map((target) => target.id));
    const stuck = ids.filter((id) => left.has(id));
    if (stuck.length) this.#stuck.set(boxId, new Set(stuck));
    this.#save();
    return ids.length - stuck.length;
  }

  async sweep(): Promise<number> {
    if (this.#sweeping) return 0;
    this.#sweeping = true;
    let closed = 0;
    try {
      forgetUsers(this.ledger, (user) => this.#deps.thread(user.botId, user.threadId).exists);
      for (const boxId of Object.keys(this.ledger)) {
        closed += await this.#queue(boxId, async () => {
          const box = this.ledger[boxId];
          if (!box || box.browserDown || this.#held(boxId)) return 0;
          const stuck = this.#stuck.get(boxId);
          const doomed = tabsToClose(box, this.#deps.thread, this.#now(), this.#cap).filter((tab) => !stuck?.has(tab.id));
          if (!doomed.length) return 0;
          const shut = await this.#close(boxId, doomed.map((tab) => tab.id));
          if (shut) this.#deps.log?.(`[janitor] closed ${shut} cloud computer tab(s): ${reasons(doomed)}`);
          return shut;
        });
      }
      for (const [boxId, box] of Object.entries(this.ledger)) {
        if (!Object.keys(box.tabs).length && !Object.keys(box.users).length) delete this.ledger[boxId];
      }
      this.#save();
    } finally {
      this.#sweeping = false;
    }
    return closed;
  }

  idle(): Promise<void> {
    return Promise.all(this.#queues.values()).then(() => undefined);
  }
}

function reasons(tabs: Array<{ reason: TabCloseReason }>): string {
  return [...new Set(tabs.map((tab) => tab.reason))].join(", ");
}
