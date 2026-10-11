import { describe, expect, it } from "vitest";
import { askInputSummary } from "../tool-summary.ts";
import { fileChangeDetail } from "./file-change-detail.ts";

describe("fileChangeDetail", () => {
  it("shows a new file's path and the words going into it", () => {
    expect(fileChangeDetail({
      file_path: "/tmp/dog/haiku.md",
      content: "Loyal paws padding\nTail wags like a metronome\nHome is where you are\n",
    })).toBe("/tmp/dog/haiku.md\n\nLoyal paws padding\nTail wags like a metronome\nHome is where you are");
  });

  it("shows an edit as the lines taken out and the lines put in", () => {
    expect(fileChangeDetail({
      file_path: "src/a.ts",
      old_string: "const a = 1;",
      new_string: "const a = 2;\r\nconst b = 3;",
      replace_all: true,
    })).toBe("src/a.ts\nreplace_all: true\n\n- const a = 1;\n+ const a = 2;\n+ const b = 3;");
  });

  it("shows every edit of a multi-edit, and leaves out an empty side", () => {
    expect(fileChangeDetail({
      file_path: "src/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "", new_string: "c", replace_all: true },
      ],
    })).toBe("src/a.ts\n\n- a\n+ b\n\nreplace_all: true\n+ c");
  });

  it("shows a notebook cell's new source with the cell it changes", () => {
    expect(fileChangeDetail({
      notebook_path: "/work/plot.ipynb",
      cell_id: "abc",
      new_source: "print(1)",
      edit_mode: "replace",
    })).toBe("/work/plot.ipynb\ncell_id: abc\nedit_mode: replace\n\nprint(1)");
  });

  it("shows just the path for an empty file", () => {
    expect(fileChangeDetail({ file_path: "/tmp/empty.txt", content: "" })).toBe("/tmp/empty.txt");
  });

  it("puts other settings on one short line each", () => {
    const detail = fileChangeDetail({ file_path: "/a", content: "x", note: `first\nsecond ${"y".repeat(300)}` });
    expect(detail).toBe(`/a\nnote: first second ${"y".repeat(187)}…\n\nx`);
  });

  it("hides keys in the file and in its settings", () => {
    const key = `sk-ant-${"a".repeat(40)}`;
    const detail = fileChangeDetail({ file_path: "/app/.env", content: `ANTHROPIC_API_KEY=${key}\nPORT=3000`, api_token: "short" });
    expect(detail).not.toContain(key);
    expect(detail).not.toContain("short");
    expect(detail).toContain("PORT=3000");
    expect(detail).toContain("«redacted");
  });

  it("shortens a long file at a line, and says it did", () => {
    const content = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n");
    const detail = fileChangeDetail({ file_path: "/big.txt", content })!;
    expect(detail.length).toBeLessThanOrEqual(2_002);
    expect(detail.endsWith("\n…")).toBe(true);
    expect(detail.split("\n").at(-2)).toMatch(/^line \d+$/);
  });

  it("leaves calls that change nothing to the plain arguments", () => {
    expect(fileChangeDetail({ file_path: "/tmp/notes.md" })).toBeUndefined();
    expect(fileChangeDetail({ file_path: "/tmp/notes.md", offset: 3 })).toBeUndefined();
    expect(fileChangeDetail({ content: "no path" })).toBeUndefined();
    expect(fileChangeDetail({ file_path: " ", content: "blank path" })).toBeUndefined();
    expect(fileChangeDetail({ file_path: "/a", edits: [{ old_string: 1 }] })).toBeUndefined();
  });
});

describe("askInputSummary with a file change", () => {
  it("gives an approval the readable file change instead of cut-off JSON", () => {
    expect(askInputSummary({ file_path: "/tmp/notes.md", content: "hello" })).toBe("/tmp/notes.md\n\nhello");
  });

  it("marks a long command or long arguments as cut", () => {
    expect(askInputSummary({ url: `https://example.com/${"p".repeat(300)}` })).toBe(`https://example.com/${"p".repeat(180)}…`);
    expect(askInputSummary({ pattern: "q".repeat(300) })!.endsWith("…")).toBe(true);
  });
});
