import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { failedTurnTool } from "../../shared/failed-turn";
import { groupTranscript } from "./activity-runs";
import { foldedRuns, foldExchanges, quietTranscriptItemShown } from "./quiet-lines";

let n = 0;
const at = () => ++n * 1000;
const user = (text: string): Message => ({ id: `m${n + 1}`, role: "user", kind: "text", at: at(), text });
const reply = (text: string): Message => ({ id: `m${n + 1}`, role: "bot", kind: "text", at: at(), text, turnId: "t1" });
const failure = (cause: string, flags: Parameters<typeof failedTurnTool>[1] = {}): Message => ({ id: `m${n + 1}`, role: "bot", kind: "activity", at: at(), tool: failedTurnTool(cause, { who: "Scout", ...flags }) });
const digest = (): Message => ({ id: `m${n + 1}`, role: "bot", kind: "digest", at: at(), text: "[digest]" });
const recovery = (pickup: "watch" | "restart", line = "Scout stopped before finishing, so it is carrying on by itself."): Message => ({
  id: `m${n + 1}`, role: "bot", kind: "activity", at: at(), tool: { name: `recovery: ${line}`, ok: true, pickup },
});
const watchFailure = (): Message => ({
  id: `m${n + 1}`, role: "bot", kind: "activity", at: at(),
  tool: { ...failedTurnTool("Scout stopped before finishing and has not picked it up again. Send a message to carry on.", { written: true }), pickup: "watch" },
});

const visible = (messages: Message[], showCalls = false) =>
  foldExchanges(groupTranscript(messages), { renders: (item) => quietTranscriptItemShown(item, showCalls) })
    .filter((item) => item.kind !== "message" || quietTranscriptItemShown(item, showCalls));

const LIVE = `claude exited null before result: [claude-code:unrecognized_model] {"model":"claude-fable-5-2","query_source":"sdk"}`;

describe("a dog that recovers by itself", () => {
  it("shows the recovery line alone, with the turn's failures under it", () => {
    const helpers = failure("The helpers stopped with this turn.");
    const died = failure(LIVE);
    const picked = recovery("watch");
    const items = visible([user("Run both commands"), reply("Running both now."), helpers, died, digest(), picked, reply("Both commands ran.")]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "recovered", "message"]);
    const folded = items[2]!;
    expect(folded.kind === "recovered" && folded.recovery.id).toBe(picked.id);
    expect(folded.kind === "recovered" && folded.folded.map((message) => message.id)).toEqual([helpers.id, died.id]);
    expect(folded.kind === "recovered" && folded.folded.map((message) => message.tool?.name)).toEqual([
      "error: The helpers stopped with this turn.",
      "error: Scout stopped before it finished.",
    ]);
    expect(folded.kind === "recovered" && folded.folded[1]!.tool?.detail).toBe(LIVE);
  });

  it("folds the same way after a restart pickup", () => {
    const died = failure("codex exited 1 before turn/completed");
    const items = visible([user("Go on"), died, recovery("restart", "Scout is picking up where it left off.")]);
    expect(items.map((item) => item.kind)).toEqual(["message", "recovered"]);
  });

  it("still folds when tool calls are shown and a digest sits between", () => {
    const items = visible([user("Go on"), failure(LIVE), digest(), recovery("watch")], true);
    expect(items.map((item) => item.kind === "message" ? item.message.kind : item.kind)).toEqual(["text", "digest", "recovered"]);
  });

  it("shows a failure alone as the failure", () => {
    const died = failure(LIVE);
    const items = visible([user("Go on"), died]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message"]);
    expect(items[1]!.kind === "message" && items[1]!.message.tool?.name).toBe("error: Scout stopped before it finished.");
  });

  it("shows a recovery line with nothing to fold as itself", () => {
    const items = visible([user("Go on"), reply("Done so far."), recovery("watch")]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "message"]);
  });

  it("does not reach past the person's message or the dog's reply", () => {
    const earlier = failure("claude exited 1 before result");
    const items = visible([user("First"), earlier, user("Second"), reply("Working."), recovery("watch")]);
    expect(items.some((item) => item.kind === "recovered")).toBe(false);
    expect(items.filter((item) => item.kind === "message" && item.message.id === earlier.id)).toHaveLength(1);
  });

  it.each([
    ["a sign-in row then a helpers line", [failure("Claude needs you to sign in again.", { setup: true }), failure("A helper stopped when this turn ended.")]],
    ["an update prompt then an exit", [failure("Please update Claude Code", { setup: true, claudeUpdate: true }), failure("claude exited 1 before result")]],
    ["a safety block then an exit", [failure("503: This task was blocked by our safety systems."), failure("claude exited 1 before result")]],
    ["the Mac permission message", [failure("CUA Driver is not ready for this computer — check permissions and restart later.dog")]],
    ["an exit whose tail says to sign in", [failure("claude exited 1 before result: Not logged in · Please run /login")]],
  ] as const)("never folds a row that asks the person to act: %s", (_label, rows) => {
    const items = visible([user("Go"), ...rows, recovery("watch")]);
    expect(items.some((item) => item.kind === "recovered")).toBe(false);
    expect(items.filter((item) => item.kind === "message" && item.message.tool?.ok === false)).toHaveLength(rows.length);
  });

  it("names when the folded attempt began, so its own work folds with it", () => {
    const asked = user("Go on");
    const items = visible([asked, failure(LIVE), recovery("watch")]);
    const folded = items.find((item) => item.kind === "recovered");
    expect(folded?.kind === "recovered" && folded.since).toBe(asked.at);
    const runs = [{ id: "before", startedAt: asked.at - 1 }, { id: "failed", startedAt: asked.at + 1 }, { id: "after", startedAt: Number.MAX_SAFE_INTEGER }];
    expect(folded?.kind === "recovered" && foldedRuns(folded, runs).map((run) => run.id)).toEqual(["failed"]);
  });

  it("folds no work from before the visible window when it starts at the failure", () => {
    const died = failure(LIVE);
    const items = visible([died, recovery("watch")]);
    const folded = items.find((item) => item.kind === "recovered");
    expect(folded?.kind === "recovered" && folded.since).toBe(died.at);
    const runs = [{ id: "day before", startedAt: died.at - 86_400_000 }, { id: "failed", startedAt: died.at }];
    expect(folded?.kind === "recovered" && foldedRuns(folded, runs).map((run) => run.id)).toEqual(["failed"]);
  });

  it("leaves an account switch and a failed recovery visible", () => {
    const switched: Message = { id: "carry", role: "bot", kind: "activity", at: at(), tool: { name: "recovery: Carrying on with Work.", ok: true, carry: { from: "a", to: "b" } } };
    const items = visible([user("Go on"), failure(LIVE), switched]);
    expect(items.some((item) => item.kind === "recovered")).toBe(false);
    const after = visible([user("Go on"), failure(LIVE), recovery("watch"), watchFailure()]);
    expect(after.map((item) => item.kind)).toEqual(["message", "recovered", "message"]);
    expect(after[2]!.kind === "message" && after[2]!.message.tool?.pickup).toBe("watch");
  });
});
