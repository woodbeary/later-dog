import { describe, expect, it } from "vitest";
import { Handover, type HomeStanding, type StartSteps } from "../src/handover.ts";

interface Side {
  name: string;
  standing: HomeStanding;
  running: boolean;
  signals: number;
  handover: Handover;
}

function pair() {
  const live: string[] = [];
  const overlaps: string[] = [];
  const make = (name: string, standing: HomeStanding, sibling: () => Side): Side => {
    const side: Side = { name, standing, running: false, signals: 0, handover: null as unknown as Handover };
    side.handover = new Handover({
      standing: () => side.standing,
      stand: async (next) => {
        side.standing = next;
      },
      running: () => side.running,
      quiet: async () => {
        if (side.running) side.signals += 1;
      },
      siblings: () => [{ release: () => sibling().handover.release() }],
    });
    return side;
  };
  const standard: Side = make("standard", "holding", () => large);
  const large: Side = make("large", "released", () => standard);
  const steps = (side: Side, hold?: { prepare?: Promise<void>; start?: Promise<void>; starting?: () => void }): StartSteps & { started: boolean } => {
    const result = {
      started: false,
      prepare: async () => {
        await hold?.prepare;
      },
      start: async () => {
        hold?.starting?.();
        await hold?.start;
        if (live.length) overlaps.push(`${side.name} started while ${live.join(", ")} ran`);
        live.push(side.name);
        side.running = true;
        result.started = true;
      },
      stop: async () => {
        side.signals += 1;
      },
    };
    return result;
  };
  const exit = (side: Side) => {
    side.running = false;
    live.splice(live.indexOf(side.name), 1);
  };
  return { standard, large, steps, exit, overlaps };
}

function deferred() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("handing a home between its two computers", () => {
  it("lets the standard home run without asking anyone, the way every home always has", async () => {
    const { standard, large, steps } = pair();
    const start = steps(standard);
    expect(await standard.handover.start(false, start)).toBe(true);
    expect(start.started).toBe(true);
    expect(large.standing).toBe("released");
  });

  it("does not let an alarm on the released side take the home", async () => {
    const { standard, large, steps } = pair();
    expect(await large.handover.start(false, steps(large))).toBe(false);
    expect(standard.standing).toBe("holding");
  });

  it("asks the running side to stop and starts only once it has stopped", async () => {
    const { standard, large, steps, exit, overlaps } = pair();
    await standard.handover.start(true, steps(standard));
    expect(await large.handover.start(true, steps(large))).toBe(false);
    expect(standard.standing).toBe("released");
    expect(standard.signals).toBe(1);
    expect(large.running).toBe(false);
    exit(standard);
    expect(await large.handover.start(true, steps(large))).toBe(true);
    expect(large.standing).toBe("holding");
    expect(overlaps).toEqual([]);
  });

  it("refuses to let go while it is in the middle of starting, then stops itself", async () => {
    const { standard, large, steps, exit, overlaps } = pair();
    const opening = deferred();
    const reached = deferred();
    const start = steps(standard, { start: opening.promise, starting: reached.open });
    const starting = standard.handover.start(true, start);
    await reached.promise;
    expect(await large.handover.start(true, steps(large))).toBe(false);
    opening.open();
    expect(await starting).toBe(false);
    expect(start.started).toBe(true);
    expect(standard.signals).toBe(1);
    exit(standard);
    expect(await large.handover.start(true, steps(large))).toBe(true);
    expect(overlaps).toEqual([]);
  });

  it("does not start at all when it is released while getting ready", async () => {
    const { standard, large, steps } = pair();
    const ready = deferred();
    const start = steps(standard, { prepare: ready.promise });
    const starting = standard.handover.start(true, start);
    await Promise.resolve();
    expect(await large.handover.start(true, steps(large))).toBe(false);
    expect(large.running).toBe(false);
    ready.open();
    expect(await starting).toBe(false);
    expect(start.started).toBe(false);
    expect(standard.standing).toBe("released");
  });

  it("lets neither side run when both claim the home at once, and one wins the next try", async () => {
    const { standard, large, steps, overlaps } = pair();
    standard.standing = "released";
    const both = await Promise.all([standard.handover.start(true, steps(standard)), large.handover.start(true, steps(large))]);
    expect(both.filter(Boolean).length).toBeLessThanOrEqual(1);
    const again = await large.handover.start(true, steps(large));
    const running = [standard.running, large.running].filter(Boolean).length;
    expect(running).toBe(again || both.some(Boolean) ? 1 : 0);
    expect(overlaps).toEqual([]);
  });
});

describe("starts that begin inside a request", () => {
  it("makes a release wait for a start that is still before its container exists", async () => {
    const { standard, large } = pair();
    const gate = deferred();
    const launched = standard.handover.launch(async () => {
      await gate.promise;
      standard.running = true;
    });
    let answered: boolean | null = null;
    const released = large.handover.release().then(() => standard.handover.release()).then((idle) => {
      answered = idle;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(answered).toBeNull();
    expect(standard.handover.idle()).toBe(false);
    gate.open();
    await launched;
    await released;
    expect(answered).toBe(false);
    expect(standard.signals).toBe(1);
  });

  it("refuses to launch once the home was released", async () => {
    const { standard } = pair();
    await standard.handover.release();
    await expect(standard.handover.launch(async () => undefined)).rejects.toThrow();
  });
});

describe("release lanes with three possible owners", () => {
  function lanes() {
    const sides: Side[] = [];
    const live = new Set<string>();
    const overlaps: string[] = [];
    for (const name of ["standard", "large", "candidate"]) {
      const side = { name, standing: "released" as HomeStanding, running: false, signals: 0, handover: null as unknown as Handover };
      side.handover = new Handover({
        standing: () => side.standing,
        stand: async (standing) => { side.standing = standing; },
        running: () => side.running,
        quiet: async () => { if (side.running) side.signals += 1; },
        siblings: () => sides.filter((other) => other !== side).map((other) => ({ release: () => other.handover.release() })),
      });
      sides.push(side);
    }
    const steps = (side: Side, prepare: () => Promise<void> = async () => undefined): StartSteps => ({
      prepare,
      start: async () => {
        if (live.size) overlaps.push(`${side.name} overlaps ${[...live].join(",")}`);
        live.add(side.name);
        side.running = true;
      },
      stop: async () => { side.signals += 1; },
    });
    const exit = (side: Side) => { live.delete(side.name); side.running = false; };
    return { sides, steps, exit, overlaps };
  }

  it("waits for every peer, including an in-flight launch on the non-selected size", async () => {
    const { sides: [standard, large, candidate], steps, exit, overlaps } = lanes();
    standard.standing = "holding";
    large.standing = "holding";
    const pending = deferred();
    const launched = large.handover.launch(async () => { await pending.promise; large.running = true; });
    const claiming = candidate.handover.start(true, steps(candidate));
    await Promise.resolve();
    expect(candidate.running).toBe(false);
    pending.open();
    await launched;
    expect(await claiming).toBe(false);
    expect(standard.standing).toBe("released");
    expect(large.signals).toBe(1);
    exit(large);
    expect(await candidate.handover.start(true, steps(candidate))).toBe(true);
    expect(overlaps).toEqual([]);
  });

  it("cancels an in-flight checkpoint when another owner claims and never starts twice", async () => {
    const { sides, steps, exit, overlaps } = lanes();
    const pending = deferred();
    const reached = deferred();
    const candidate = sides[2];
    const starting = candidate.handover.start(true, steps(candidate, async () => { reached.open(); await pending.promise; }));
    await reached.promise;
    expect(await sides[0].handover.start(true, steps(sides[0]))).toBe(false);
    pending.open();
    expect(await starting).toBe(false);
    for (let round = 0; round < 12; round += 1) {
      await Promise.all(sides.map((side) => side.handover.start(true, steps(side))));
      expect(sides.filter((side) => side.running).length).toBeLessThanOrEqual(1);
      for (const side of sides) exit(side);
    }
    expect(overlaps).toEqual([]);
  });
});
