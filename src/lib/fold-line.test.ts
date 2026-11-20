import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import type { NativeRun } from "../../shared/native-runs";
import { turnFolds } from "./fold-line";

let at = 0;
const row = (id: string, fields: Partial<Message>): Message => ({ id, role: "bot", kind: "text", at: ++at, ...fields });
const tool = (id: string, name: string, turnId = "t1", ok: boolean | undefined = true) => row(id, { kind: "activity", turnId, tool: { name, ok } });

const turn: Message[] = [
  row("u1", { role: "user", text: "Add a pickup time" }),
  row("b1", { turnId: "t1", text: "On it." }),
  tool("a1", "Read"),
  tool("a2", "Edit"),
  tool("a3", "Bash"),
  tool("a4", "Edit"),
  tool("a5", "Bash", "t1", false),
  tool("a6", "TodoWrite"),
  tool("a7", "Bash"),
  row("b2", { turnId: "t1", text: "Done.", turnTerminal: true }),
];

describe("the folded line of a finished turn", () => {
  it("sits above the turn's last answer and tells what the dog did, plan updates not counted", () => {
    const folds = turnFolds(turn, []);
    expect([...folds.keys()]).toEqual(["b2"]);
    expect(folds.get("b2")).toMatchObject({ turnId: "t1", sentence: "Made 2 changes and tried 3 things" });
  });

  it("names the turn's own finished run so the panel opens on it", () => {
    const run = { id: "run-9", threadId: "th", turnId: "t1", endedAt: 50, observation: "complete" } as NativeRun;
    expect(turnFolds(turn, [run]).get("b2")?.runId).toBe("run-9");
    expect(turnFolds(turn, []).get("b2")?.runId).toBeUndefined();
  });

  it("leaves a turn that is still going, or one with no steps, without a fold", () => {
    expect(turnFolds(turn.slice(0, -1), []).size).toBe(0);
    expect(turnFolds([row("u2", { role: "user", text: "hi" }), row("b3", { turnId: "t2", text: "Hello", turnTerminal: true })], []).size).toBe(0);
  });

  it("does not count status lines, failed-turn rows, or messages to other dogs", () => {
    const quiet = [
      row("u3", { role: "user", text: "go" }),
      tool("n1", "notice: Picked up again", "t3"),
      row("c1", { kind: "activity", turnId: "t3", tool: { name: "Asked Otis", ok: true }, comm: { groupId: "g", withBotId: "o", withName: "Otis", withColor: "blue" } as Message["comm"] }),
      tool("r1", "Read", "t3"),
      row("b4", { turnId: "t3", text: "Here.", turnTerminal: true }),
    ];
    expect(turnFolds(quiet, []).get("b4")?.sentence).toBe("Looked at 1 thing");
  });
});
