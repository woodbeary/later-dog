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
