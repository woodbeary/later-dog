import { describe, expect, it } from "vitest";
import { dogActivityWords } from "./activity-words.ts";

const nameOf = () => undefined;

describe("what the working line says while a dog is on the Mac", () => {
  it("says what the dog is doing on the Mac, and picking a computer only while it chooses", () => {
    expect(dogActivityWords("mcp__agents__shared_computer", { action: "run_command", command: "ls" }, nameOf)).toBe("running ls on your Mac");
    expect(dogActivityWords("shared_computer", undefined, nameOf)).toBe("using your Mac");
    expect(dogActivityWords("mcp__agents__select_computer", { surface: "auto" }, nameOf)).toBe("picking a computer");
    expect(dogActivityWords("mcp__agents__list_shared_computers", undefined, nameOf)).toBe("picking a computer");
  });

  it("names the command, file or folder work instead of a bare using your Mac", () => {
    const words = (input: Record<string, unknown>) => dogActivityWords("mcp__agents__shared_computer", input, nameOf);
    expect(words({ action: "run_command", command: "export PATH=/x:$PATH; pnpm exec vitest run src" })).toBe("running vitest on your Mac");
    expect(words({ action: "run_command", command: "git merge --no-edit restore/x" })).toBe("running git merge on your Mac");
    expect(words({ action: "read_file", path: "/Users/j/code/dog/src/components/ActivityPeek.tsx" })).toBe("reading ActivityPeek.tsx on your Mac");
    expect(words({ action: "edit_file", path: "notes.md" })).toBe("editing notes.md on your Mac");
    expect(words({ action: "command_output", command_id: "1" })).toBe("checking a command on your Mac");
    expect(words({ action: "search_files", pattern: "x" })).toBe("looking through files on your Mac");
    expect(words({ action: "computer_call", tool_name: "click" })).toBe("using your Mac's screen");
  });
});
