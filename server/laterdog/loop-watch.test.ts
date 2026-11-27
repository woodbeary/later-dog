import { expect, it } from "vitest";
import { watchEventLoop } from "./loop-watch.ts";

it("names a stretch where the server could not answer", async () => {
  const lines: string[] = [];
  const stop = watchEventLoop({ log: (line) => lines.push(line), everyMs: 20, heldMs: 100, context: () => "turn ff3416d8 setting up" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const until = Date.now() + 200;
  while (Date.now() < until) {}
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  expect(lines.some((line) => /^event loop held \d+ ms \(turn ff3416d8 setting up\)$/.test(line))).toBe(true);
});
