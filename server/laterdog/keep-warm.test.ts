import { expect, it } from "vitest";
import { createKeepWarm } from "./keep-warm.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

it("keeps a chat the person used today warm for the rest of its working day, at most three per computer", () => {
  const warm = createKeepWarm();
  const start = 1_000_000_000;
  expect(warm.idleMs("never-asked", 10 * MIN, start)).toBe(10 * MIN);
  warm.personAsked("dog-a", "chat-1", start);
  expect(warm.idleMs("chat-1", 10 * MIN, start + HOUR)).toBe(9 * HOUR);
  expect(warm.idleMs("chat-1", 10 * MIN, start + 9 * HOUR + 55 * MIN)).toBe(10 * MIN);
  expect(warm.idleMs("chat-1", 10 * MIN, start + 25 * HOUR)).toBe(10 * MIN);
  for (const [chat, at] of [["chat-2", 1], ["chat-3", 2], ["chat-4", 3]] as const) warm.personAsked("dog-a", chat, start + at * MIN);
  warm.personAsked("dog-b", "chat-5", start + 4 * MIN);
  expect(warm.idleMs("chat-1", 10 * MIN, start + HOUR)).toBe(10 * MIN);
  expect(warm.idleMs("chat-2", 10 * MIN, start + HOUR)).toBe(9 * HOUR + MIN);
  expect(warm.idleMs("chat-5", 10 * MIN, start + HOUR)).toBe(9 * HOUR + 4 * MIN);
  warm.forget("chat-4");
  expect(warm.idleMs("chat-1", 10 * MIN, start + HOUR)).toBe(9 * HOUR);
});
