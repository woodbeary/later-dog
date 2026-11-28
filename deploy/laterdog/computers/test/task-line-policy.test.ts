import { describe, expect, it } from "vitest";
import { MINUTE } from "../src/idle";
import {
  LEASE_MS,
  type Machine,
  type Ticket,
  UNPOLLED_DROP_MS,
  defaultSettings,
  machineIdFor,
  machinesMax,
  nextCheckAt,
  parseSettings,
  parseTicketRequest,
  parseWaitSeconds,
  placeOf,
  settle,
} from "../src/task-line-policy";

const NOW = Date.UTC(2026, 10, 26, 12);

let seq = 0;
function ticket(fields: Partial<Ticket> & { id: string }): Ticket {
  seq += 1;
  return { key: `k-${fields.id}`, thread: `t-${fields.id}`, size: "small", class: "task", state: "queued", seq, createdAt: NOW, polledAt: NOW, ...fields };
}

const settings = (cap: number) => ({ ...defaultSettings(100), cap });
const named = (t: Ticket) => `m-${t.thread}-${t.size}`;

describe("task line admission", () => {
  it("admits under the cap and leaves the rest queued with places", () => {
    const tickets = ["a", "b", "c", "d", "e"].map((id) => ticket({ id }));
    const result = settle({ now: NOW, settings: settings(3), tickets, machines: [] }, named);
    expect(result.admit.map((a) => a.ticketId)).toEqual(["a", "b", "c"]);
    expect(result.newMachines.map((m) => m.id)).toEqual(["m-t-a-small", "m-t-b-small", "m-t-c-small"]);
    const after = tickets.map((t) => (result.admit.some((a) => a.ticketId === t.id) ? { ...t, state: "admitted" as const } : t));
    expect(placeOf(after[3]!, after)).toBe(1);
    expect(placeOf(after[4]!, after)).toBe(2);
    expect(placeOf(after[0]!, after)).toBeUndefined();
  });

  it("serves the person first, then dog tasks, then routines, first come first served inside a class", () => {
    const tickets = [ticket({ id: "r1", class: "routine" }), ticket({ id: "t1", class: "task" }), ticket({ id: "p1", class: "person" }), ticket({ id: "t2", class: "task" }), ticket({ id: "p2", class: "person" })];
    const result = settle({ now: NOW, settings: settings(3), tickets, machines: [] }, named);
    expect(result.admit.map((a) => a.ticketId)).toEqual(["p1", "p2", "t1"]);
    const after = tickets.map((t) => (result.admit.some((a) => a.ticketId === t.id) ? { ...t, state: "admitted" as const } : t));
    expect(placeOf(after.find((t) => t.id === "t2")!, after)).toBe(1);
    expect(placeOf(after.find((t) => t.id === "r1")!, after)).toBe(2);
  });

  it("lets a lowered cap keep running work and admits nothing new", () => {
    const machines: Machine[] = ["a", "b", "c"].map((id) => ({ id: `m-${id}`, thread: `t-${id}`, size: "small", startedAt: NOW, ticketId: id }));
    const tickets = [...["a", "b", "c"].map((id) => ticket({ id, state: "admitted", machineId: `m-${id}`, leaseUntil: NOW + LEASE_MS })), ticket({ id: "d" })];
    const result = settle({ now: NOW, settings: settings(1), tickets, machines }, named);
    expect(result).toMatchObject({ admit: [], stop: [], expire: [], release: [] });
  });

  it("reuses a thread's idle machine at once, even at the cap", () => {
    const machines: Machine[] = [
      { id: "m-a", thread: "t-a", size: "small", startedAt: NOW - 5000, idleSince: NOW - 1000 },
      { id: "m-b", thread: "t-b", size: "small", startedAt: NOW - 5000, ticketId: "b" },
    ];
    const tickets = [ticket({ id: "b", state: "admitted", machineId: "m-b", leaseUntil: NOW + LEASE_MS }), ticket({ id: "x" }), ticket({ id: "a2", thread: "t-a" })];
    const result = settle({ now: NOW, settings: settings(2), tickets, machines }, named);
    expect(result.admit).toEqual([{ ticketId: "a2", machineId: "m-a", reuse: true }]);
    expect(result.stop).toEqual([]);
  });

  it("keeps a second ticket for a busy thread waiting for that thread's machine", () => {
    const machines: Machine[] = [{ id: "m-a", thread: "t-a", size: "small", startedAt: NOW, ticketId: "a" }];
    const tickets = [ticket({ id: "a", state: "admitted", machineId: "m-a", thread: "t-a", leaseUntil: NOW + LEASE_MS }), ticket({ id: "a2", thread: "t-a" })];
    const result = settle({ now: NOW, settings: settings(5), tickets, machines }, named);
    expect(result.admit).toEqual([]);
  });

  it("replaces a thread's idle small machine when its ticket asks for large", () => {
    const machines: Machine[] = [{ id: "m-t-a-small", thread: "t-a", size: "small", startedAt: NOW - 5000, idleSince: NOW - 1000 }];
    const result = settle({ now: NOW, settings: settings(1), tickets: [ticket({ id: "a2", thread: "t-a", size: "large" })], machines }, named);
    expect(result.stop).toEqual(["m-t-a-small"]);
    expect(result.admit).toEqual([{ ticketId: "a2", machineId: "m-t-a-large", reuse: false }]);
  });

  it("at the cap with work waiting stops the longest-idle machine first, never a busy one", () => {
    const machines: Machine[] = [
      { id: "m-busy", thread: "t-busy", size: "small", startedAt: NOW - 90_000, ticketId: "busy" },
      { id: "m-new-idle", thread: "t-1", size: "small", startedAt: NOW - 60_000, idleSince: NOW - 10_000 },
      { id: "m-old-idle", thread: "t-2", size: "small", startedAt: NOW - 60_000, idleSince: NOW - 50_000 },
    ];
    const tickets = [ticket({ id: "busy", state: "admitted", machineId: "m-busy", leaseUntil: NOW + LEASE_MS }), ticket({ id: "w" })];
    const result = settle({ now: NOW, settings: settings(3), tickets, machines }, named);
    expect(result.stop).toEqual(["m-old-idle"]);
    expect(result.admit).toEqual([{ ticketId: "w", machineId: "m-t-w-small", reuse: false }]);
  });

  it("stops an idle machine after the idle minutes, and not before", () => {
    const idle = (since: number): Machine => ({ id: "m", thread: "t", size: "small", startedAt: NOW - 3_600_000, idleSince: since });
    expect(settle({ now: NOW, settings: settings(5), tickets: [], machines: [idle(NOW - 5 * MINUTE + 1)] }, named).stop).toEqual([]);
    expect(settle({ now: NOW, settings: settings(5), tickets: [], machines: [idle(NOW - 5 * MINUTE)] }, named).stop).toEqual(["m"]);
  });

  it("expires a lease nobody renewed and frees its machine as idle from the lease's end", () => {
    const machines: Machine[] = [{ id: "m-a", thread: "t-a", size: "small", startedAt: NOW - LEASE_MS * 2, ticketId: "a" }];
    const tickets = [ticket({ id: "a", state: "admitted", machineId: "m-a", leaseUntil: NOW - 1 })];
    const result = settle({ now: NOW, settings: settings(5), tickets, machines }, named);
    expect(result.release).toEqual(["a"]);
    expect(result.idle).toEqual([{ machineId: "m-a", since: NOW - 1 }]);
  });

  it("drops a queued ticket nobody polled for a minute", () => {
    const stale = ticket({ id: "s", polledAt: NOW - UNPOLLED_DROP_MS - 1 });
    const fresh = ticket({ id: "f", polledAt: NOW - UNPOLLED_DROP_MS });
    const result = settle({ now: NOW, settings: settings(1), tickets: [stale, fresh], machines: [{ id: "m", thread: "busy", size: "small", startedAt: NOW, ticketId: "z" }] }, named);
    expect(result.expire).toEqual(["s"]);
  });

  it("checks again in 30 seconds only while something is queued, admitted or running", () => {
    expect(nextCheckAt({ now: NOW, settings: settings(1), tickets: [], machines: [] })).toBeUndefined();
    expect(nextCheckAt({ now: NOW, settings: settings(1), tickets: [ticket({ id: "q" })], machines: [] })).toBe(NOW + 30_000);
  });
});

describe("task line inputs", () => {
  it("bounds the cap by TASK_MACHINES_MAX and the idle minutes from 2 to 30", () => {
    const current = defaultSettings(100);
    expect(current).toEqual({ cap: 20, idleMinutes: 5, sizes: { small: "small", large: "xlarge" } });
    expect(defaultSettings(8).cap).toBe(8);
    expect(parseSettings({ cap: 100 }, current, 100)).toMatchObject({ ok: true, value: { cap: 100 } });
    expect(parseSettings({ cap: 101 }, current, 100)).toMatchObject({ ok: false, refusal: { code: "invalid_cap" } });
    expect(parseSettings({ cap: 0 }, current, 100)).toMatchObject({ ok: false });
    expect(parseSettings({ idleMinutes: 1 }, current, 100)).toMatchObject({ ok: false, refusal: { code: "invalid_idle_minutes" } });
    expect(parseSettings({ idleMinutes: 30, sizes: { small: "standard" } }, current, 100)).toMatchObject({ ok: true, value: { idleMinutes: 30, sizes: { small: "standard", large: "xlarge" } } });
    expect(parseSettings({ sizes: { huge: "xlarge" } }, current, 100)).toMatchObject({ ok: false });
    expect(machinesMax({})).toBe(100);
    expect(machinesMax({ TASK_MACHINES_MAX: "12" })).toBe(12);
  });

  it("reads a ticket request with defaults and refuses unknown classes and sizes", () => {
    expect(parseTicketRequest({ key: "home:t1:d1", thread: "t1" })).toEqual({ ok: true, value: { key: "home:t1:d1", thread: "t1", size: "small", class: "task" } });
    expect(parseTicketRequest({ key: "k", thread: "t", dog: "scout", size: "large", class: "person" })).toMatchObject({ ok: true, value: { dog: "scout", size: "large", class: "person" } });
    expect(parseTicketRequest({ key: "k", thread: "t", class: "vip" })).toMatchObject({ ok: false, refusal: { code: "invalid_class" } });
    expect(parseTicketRequest({ key: "k", thread: "t", size: "medium" })).toMatchObject({ ok: false, refusal: { code: "invalid_size" } });
    expect(parseTicketRequest({ thread: "t" })).toMatchObject({ ok: false, refusal: { code: "invalid_key" } });
    expect(parseWaitSeconds("20")).toBe(20);
    expect(parseWaitSeconds("600")).toBe(25);
    expect(parseWaitSeconds("x")).toBe(0);
  });

  it("names one machine per home, dog, thread and size, shaped like a computer id", async () => {
    const one = await machineIdFor("registry", { thread: "t1", dog: "scout", size: "small" });
    expect(one).toMatch(/^cmp_[a-z2-7]{12}$/);
    expect(await machineIdFor("registry", { thread: "t1", dog: "scout", size: "small" })).toBe(one);
    expect(await machineIdFor("registry", { thread: "t1", dog: "scout", size: "large" })).not.toBe(one);
    expect(await machineIdFor("other-home", { thread: "t1", dog: "scout", size: "small" })).not.toBe(one);
  });
});
