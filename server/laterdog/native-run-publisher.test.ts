import { afterEach, expect, it, vi } from "vitest";
import type { NativeRun } from "../../shared/native-runs.ts";
import { NativeRunPublisher } from "./native-run-publisher.ts";

afterEach(() => vi.useRealTimers());
const run = (revision: number, observation: NativeRun["observation"] = "live"): NativeRun => ({ id: "run", threadId: "thread", turnId: "turn", provider: "codex", revision, startedAt: 1, state: "running", observation, actors: [], activityCount: 1, failureCount: 0, limitations: [] });

it("coalesces streaming revisions without delaying a final receipt or emitting stale pending state", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const publisher = new NativeRunPublisher(send, 150);
  publisher.publish(run(1));
  for (let revision = 2; revision <= 100; revision++) publisher.publish(run(revision));
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(150);
  expect(send.mock.calls.map(([run]) => run.revision)).toEqual([1, 100]);
  publisher.publish(run(101));
  publisher.publish(run(102, "complete"));
  publisher.publish(run(101));
  vi.advanceTimersByTime(150);
  expect(send.mock.calls.map(([run]) => run.revision)).toEqual([1, 100, 102]);
});

it("keeps independent runs visible while coalescing their own updates", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const publisher = new NativeRunPublisher(send);
  publisher.publish(run(1));
  publisher.publish({ ...run(1), id: "other" });
  publisher.publish(run(2));
  publisher.publish({ ...run(2), id: "other" });
  vi.advanceTimersByTime(150);
  expect(send.mock.calls.map(([run]) => [run.id, run.revision])).toEqual([["run", 1], ["other", 1], ["run", 2], ["other", 2]]);
});
