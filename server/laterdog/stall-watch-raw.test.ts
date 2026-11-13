import { describe, expect, it } from "vitest";
import { failedTurnTool } from "../../shared/failed-turn.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { judgeChat, type ChatNow } from "./stall-watch.ts";

const T0 = Date.parse("2026-11-13T09:00:00Z");
let seq = 0;
const row = (at: number, fields: Partial<WireMessage>): WireMessage => ({ id: `m${++seq}`, role: "bot", kind: "text", at, ...fields } as WireMessage);
const ask = (at: number) => row(at, { role: "user", text: "please ship the fix" });
const ran = (at: number) => row(at, { kind: "activity", turnId: "t1", tool: { name: "Bash", ok: true, itemId: `i${seq}` } });
const failed = (at: number, cause: string, who: string, flags: Parameters<typeof failedTurnTool>[1] = {}) =>
  row(at, { kind: "activity", tool: failedTurnTool(cause, { who, ...flags }) });
const chat = (name: string, path: WireMessage[]): ChatNow => ({
  name, path, busy: false, requestOpen: false, helpers: 0, usageWait: false, queued: false, stoppedByPerson: false,
  mayContinue: true, routine: () => false, teammates: [], now: Math.max(...path.map((message) => message.at)) + 10 * 60_000,
});
const verdict = (name: string, ...rows: WireMessage[]) => judgeChat(chat(name, [ask(T0), ran(T0 + 1), ...rows]));

describe("the stall watch decides from the raw cause, never from the sentence or the dog's name", () => {
  it.each([
    "queued message could not start — Work is turned off",
    "Could not continue on Work: Work is turned off",
  ])("explains a turned-off account instead of carrying on: %s", (cause) => {
    expect(verdict("Clover", failed(T0 + 2, cause, "Clover"))).toMatchObject({
      kind: "explain", line: "Clover stopped because Work is turned off. Turn it back on or pick another account.",
    });
  });

  it("explains a sign-in stop", () => {
    expect(verdict("Clover", failed(T0 + 2, "queued message could not start — Claude is not signed in", "Clover")))
      .toMatchObject({ kind: "explain", line: "Clover stopped because its account needs you to sign in again." });
  });

  it.each(["Login Helper", "Safety Sam", "Permission Pat"])("carries on a plain engine exit whatever the dog is called: %s", (name) => {
    expect(verdict(name, failed(T0 + 2, "claude exited 1 before result", name)))
      .toMatchObject({ kind: "continue", line: `${name} stopped before finishing, so it is carrying on by itself.` });
  });

  it("does not carry on past a sign-in row that a later helpers line follows", () => {
    expect(verdict("Scout",
      failed(T0 + 2, "Claude needs you to sign in again.", "Scout", { setup: true }),
      failed(T0 + 3, "A helper stopped when this turn ended.", "Scout"),
    )).toMatchObject({ kind: "explain", line: "Scout stopped because its account needs you to sign in again." });
  });

  it("carries on after a busy service, which it did not do when the error came as a reply, and never retries a refused request", () => {
    const overloaded = "API Error: 529 Overloaded. This is a server-side issue, usually temporary.";
    const asReply = verdict("Pepper", row(T0 + 2, { text: overloaded, turnId: "t1", turnTerminal: true, turnSucceeded: false }));
    expect(asReply).toMatchObject({ kind: "fine", why: "settled" });
    const asFailure = verdict("Pepper", failed(T0 + 2, overloaded, "Pepper"), row(T0 + 3, { kind: "digest", text: "[digest]", turnId: "t1", turnSucceeded: false }));
    expect(asFailure).toMatchObject({ kind: "continue", line: "Pepper stopped before finishing, so it is carrying on by itself." });
    const refused = verdict("Pepper", failed(T0 + 2, "API Error: 400 prompt is too long", "Pepper"));
    expect(refused).toMatchObject({ kind: "explain", line: "Pepper stopped before finishing and has not picked it up again. Send a message to carry on." });
  });
});
