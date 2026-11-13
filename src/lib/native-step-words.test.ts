import { describe, expect, it } from "vitest";
import type { NativeActivity } from "../../shared/native-runs";
import { nativeStepWords, type StepMessage } from "./native-step-words";

const step = (id: string, label: string, kind: NativeActivity["kind"] = "tool", input?: string): NativeActivity => ({ id, actorId: "parent", kind, label, state: "done", startedAt: 1, ...(input ? { input } : {}) });
const said = (name: string, spoken: string | undefined, input?: string, turnId = "turn"): StepMessage => ({ kind: "activity", turnId, tool: { name, ...(spoken ? { spoken } : {}), ...(input ? { input } : {}) } });

describe("native step words", () => {
  it("uses the working line's own words for each step, matched by tool and input", () => {
    const words = nativeStepWords(
      [step("a", "Bash", "tool", "ls"), step("b", "Bash", "tool", "pnpm test"), step("c", "TodoWrite")],
      [said("Bash", "running pnpm test", "pnpm test"), said("Bash", "running ls", "ls"), said("TodoWrite", "making a plan")],
      "turn",
    );
    expect([...words.values()]).toEqual(["Running ls", "Running pnpm test", "Making a plan"]);
  });

  it("ignores steps from other turns and never falls back to a raw tool name", () => {
    const tools = ["Bash", "TodoWrite", "Read", "mcp__laterdog__shared_computer", "WebSearch: weather"];
    const words = nativeStepWords(tools.map((label, index) => step(String(index), label, label.startsWith("WebSearch") ? "search" : "tool")), [said("TodoWrite", "making a plan", undefined, "other")], "turn");
    for (const [index, label] of tools.entries()) {
      const word = words.get(String(index))!;
      expect(word).not.toMatch(new RegExp(`\\b${label.split(":")[0]!}\\b`));
      expect(word).not.toMatch(/_|mcp/);
    }
  });

  it("names the other kinds of step plainly", () => {
    const words = nativeStepWords([step("m", "Message", "message"), step("r", "Thinking", "reasoning"), step("i", "Subagent instructions", "message"), step("n", "Claude warning", "notice"), step("c", "Context compacted", "compaction")]);
    expect([...words.values()]).toEqual(["Writing", "Thinking", "Getting its instructions", "A note along the way", "Making room to keep going"]);
  });
});
