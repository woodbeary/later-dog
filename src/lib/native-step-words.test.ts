import { describe, expect, it } from "vitest";
import type { NativeActivity, NativeActorState } from "../../shared/native-runs";
import { nativeStepWord } from "./native-step-words";

const step = (label: string, state: NativeActorState = "done", kind: NativeActivity["kind"] = "tool", input?: string): NativeActivity => ({ id: label, actorId: "parent", kind, label, state, startedAt: 1, ...(input !== undefined ? { input } : {}) });

describe("native step words", () => {
  it("says a finished step in the past and a running one in the present, from the one shared table", () => {
    expect(nativeStepWord(step("Bash", "done", "tool", "{\"command\":\"ls\"}"))).toBe("Ran a command");
    expect(nativeStepWord(step("Bash", "running", "tool", "{\"command\":\"ls\",\"description\":\"List the files\"}"))).toBe("List the files");
    expect(nativeStepWord(step("TodoWrite"))).toBe("Made a plan");
    expect(nativeStepWord(step("TodoWrite", "running"))).toBe("Making a plan");
    expect(nativeStepWord(step("Task"))).toBe("Asked a helper");
    expect(nativeStepWord(step("NotebookEdit"))).toBe("Made edits");
    expect(nativeStepWord(step("Message", "done", "message"))).toBe("Wrote the reply");
    expect(nativeStepWord(step("Thinking", "running", "reasoning"))).toBe("Thinking");
  });

  it("says the second engine's commands and file changes plainly, never the command itself", () => {
    expect(nativeStepWord(step("pnpm test", "done", "tool", "pnpm test"), "codex")).toBe("Ran a command");
    expect(nativeStepWord(step("pnpm test", "running", "tool", "pnpm test"), "codex")).toBe("Running a command");
    expect(nativeStepWord(step("File changes", "done", "tool"), "codex")).toBe("Changed files");
  });

  it("says Did a step for anything the table does not cover, never a tool name or Working", () => {
    for (const label of ["mystery_tool", "Native imageGeneration", "pnpm test"]) {
      const word = nativeStepWord(step(label));
      expect(word).toBe("Did a step");
    }
    expect(nativeStepWord(step("mystery_tool", "running"))).toBe("Doing a step");
  });
});
