import { expect, it } from "vitest";
import { HistoryLiveCache } from "./history-live-cache.ts";

it("reads once, forwards accepted live projections, and forgets ambiguous writes and recovered runs", () => {
  const cache = new HistoryLiveCache(),
    thread = "thread",
    read = { op: "native.livePage" },
    write = { op: "native.observe" };
  let calls = 0;
  const load = () => {
    calls++;
    return { runs: [] as { id: string }[] };
  };
  cache.execute(thread, read, load).runs.push({ id: "caller" });
  expect(cache.execute(thread, read, load).runs).toEqual([]);
  const run = { id: "one", threadId: thread, observation: "live", revision: 1 };
  cache.execute(thread, write, () => run);
  expect(cache.execute(thread, read, load).runs).toEqual([run]);
  cache.execute(thread, write, () => ({ ...run, observation: "complete" }));
  expect(cache.execute(thread, read, load).runs).toEqual([]);
  expect(calls).toBe(1);
  expect(() =>
    cache.execute(thread, write, () => {
      throw Error("lost ack");
    }),
  ).toThrow();
  cache.execute(thread, read, load);
  cache.invalidate([thread]);
  cache.execute(thread, read, load);
  cache.execute(thread, { op: "messages.delete" }, () => null);
  cache.execute(thread, read, load);
  expect(calls).toBe(4);
});

it("coalesces concurrent cold inventory and discards a late page when the thread changes", async () => {
  const cache = new HistoryLiveCache();
  let resume!: () => void,
    calls = 0;
  const wait = new Promise<void>((r) => {
    resume = r;
  });
  const load = async (threads: string[]) => {
    calls++;
    await wait;
    return threads.map((threadId) => ({ threadId, result: { runs: [] } }));
  };
  const one = cache.preload(["one", "two"], load),
    two = cache.preload(["two"], load);
  cache.execute("one", { op: "native.observe" }, () => ({ id: "new", threadId: "one", observation: "live" }));
  resume();
  await Promise.all([one, two]);
  expect(calls).toBe(1);
  expect(
    cache.execute("two", { op: "native.livePage" }, () => {
      throw Error("unexpected read");
    }),
  ).toEqual({ runs: [] });
  const actual = { runs: [{ id: "new", threadId: "one", observation: "live" }] };
  expect(cache.execute("one", { op: "native.livePage" }, () => actual)).toEqual(actual);
});
