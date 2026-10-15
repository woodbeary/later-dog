import { describe, expect, it } from "vitest";
import { dogActivityWords } from "./activity-words.ts";

const nameOf = () => undefined;

describe("what the working line says while a dog is on the Mac", () => {
  it("says the dog is using the Mac while it works there, and picking a computer only while it chooses", () => {
    expect(dogActivityWords("mcp__agents__shared_computer", { action: "run_command", command: "ls" }, nameOf)).toBe("using your Mac");
    expect(dogActivityWords("shared_computer", undefined, nameOf)).toBe("using your Mac");
    expect(dogActivityWords("mcp__agents__select_computer", { surface: "auto" }, nameOf)).toBe("picking a computer");
    expect(dogActivityWords("mcp__agents__list_shared_computers", undefined, nameOf)).toBe("picking a computer");
  });
});
