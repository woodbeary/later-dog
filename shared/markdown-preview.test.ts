import { describe, expect, it } from "vitest";
import { markdownPreview } from "./markdown-preview";

describe("markdownPreview", () => {
  it("reads a heading and a task list as plain words", () => {
    expect(markdownPreview("## Tool test complete\n\n- [x] Created `notes.md`\n- [x] Read it back\n\n**All good.**"))
      .toBe("Tool test complete Created notes.md Read it back All good.");
  });

  it("keeps link and image words and drops their addresses", () => {
    expect(markdownPreview("See [the docs](https://example.com/docs) and ![a chart](chart.png)."))
      .toBe("See the docs and a chart.");
    expect(markdownPreview("Open https://example.com now")).toBe("Open https://example.com now");
  });

  it("keeps the numbers of a numbered list, so a sentence starting with a year survives", () => {
    expect(markdownPreview("1. Install\n2. Run")).toBe("1. Install 2. Run");
    expect(markdownPreview("2024. What a year.")).toBe("2024. What a year.");
  });

  it("leaves out a code block when there is prose, and shows the code when there is nothing else", () => {
    expect(markdownPreview("Run this:\n\n```sh\npnpm install\n```\n\nThen restart.")).toBe("Run this: Then restart.");
    expect(markdownPreview("```ts\nconst answer = 42;\n```")).toBe("const answer = 42;");
  });

  it("flattens quotes, tables, emphasis and line breaks", () => {
    expect(markdownPreview("> Line one\n> line two")).toBe("Line one line two");
    expect(markdownPreview("| Name | Size |\n| --- | --- |\n| a.txt | 2 KB |")).toBe("Name Size a.txt 2 KB");
    expect(markdownPreview("*soft* and __strong__ and ~~gone~~")).toBe("soft and strong and gone");
    expect(markdownPreview("first  \nsecond")).toBe("first second");
  });

  it("leaves plain text, escapes and raw HTML as written", () => {
    expect(markdownPreview("All done, ready when you are")).toBe("All done, ready when you are");
    expect(markdownPreview("snake_case_name and 5 \\* 3 &amp; #1 pick")).toBe("snake_case_name and 5 * 3 & #1 pick");
    expect(markdownPreview("Use <br> here")).toBe("Use <br> here");
  });

  it("returns an empty line for empty or decoration-only text", () => {
    expect(markdownPreview("")).toBe("");
    expect(markdownPreview("---")).toBe("");
  });

  it("only reads the start of a very long message", () => {
    const long = `Start ${"word ".repeat(2_000)}secret-tail`;
    const line = markdownPreview(long);
    expect(line.startsWith("Start word")).toBe(true);
    expect(line).not.toContain("secret-tail");
  });
});
