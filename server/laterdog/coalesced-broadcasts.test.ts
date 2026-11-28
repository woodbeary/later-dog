import { describe, expect, it, vi } from "vitest";

import { coalescedBroadcasts } from "./coalesced-broadcasts.ts";

describe("coalesced broadcasts", () => {
  it("send each waiting dog once after the delay", () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const broadcasts = coalescedBroadcasts(100, (id) => sent.push(id));
      for (const id of ["a", "b", "a", "c", "b"]) broadcasts.soon(id);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(sent).toEqual(["a", "b", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hand the server back between slices when many dogs changed at once", () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const resumes: Array<() => void> = [];
      const sent: string[] = [];
      const broadcasts = coalescedBroadcasts(100, (id) => { sent.push(id); clock += 5; }, { sliceMs: 20, now: () => clock, yieldTo: (next) => resumes.push(next) });
      for (let i = 0; i < 200; i++) broadcasts.soon(`dog-${i}`);
      vi.advanceTimersByTime(100);
      expect(sent).toHaveLength(4);
      broadcasts.soon("dog-0");
      broadcasts.soon("dog-500");
      vi.advanceTimersByTime(1_000);
      expect(sent).toHaveLength(4);
      while (resumes.length) resumes.shift()!();
      expect(sent).toHaveLength(202);
      expect(new Set(sent.slice(4)).size).toBe(198);
      expect(sent).toContain("dog-500");
    } finally {
      vi.useRealTimers();
    }
  });

  it("send everything at once when flushed", () => {
    let clock = 0;
    const resumes: Array<() => void> = [];
    const sent: string[] = [];
    vi.useFakeTimers();
    try {
      const broadcasts = coalescedBroadcasts(100, (id) => { sent.push(id); clock += 50; }, { sliceMs: 20, now: () => clock, yieldTo: (next) => resumes.push(next) });
      for (let i = 0; i < 10; i++) broadcasts.soon(`dog-${i}`);
      vi.advanceTimersByTime(100);
      expect(sent).toHaveLength(1);
      broadcasts.flush();
      expect(sent).toHaveLength(10);
      while (resumes.length) resumes.shift()!();
      expect(sent).toHaveLength(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
