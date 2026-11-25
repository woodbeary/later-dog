import { describe, expect, it } from "vitest";
import { remainingComments, strip } from "./no-comments.ts";

describe("comment-free source fast path", () => {
  it.each([
    ["plain.ts", "export const value = 1;\n"],
    ["empty.ts", "try { run(); } catch {}\n"],
    ["empty.tsx", "export const view = <div>{}</div>;\n"],
    ["pattern.ts", "const pattern = /[/]/;\n"],
    ["text.tsx", "const view = <p>ordinary text</p>;\n"],
    ["url.ts", 'const url = "https://later.dog";\n'],
    ["literal.ts", 'const text = "/* shown */ // shown";\n'],
    ["template.ts", "const text = `// shown ${1} /* shown */`;\n"],
    ["text.tsx", "const view = <p>// shown as text</p>;\n"],
  ])("preserves %s and its source bytes", (file, text) => {
    expect(remainingComments(file, text)).toEqual([]);
    expect(strip(file, text)).toEqual({ text, removed: 0 });
  });

  it.each([
    ["line.ts", "const value = 1; // forbidden\n"],
    ["block.ts", "const value = /* forbidden */ 1;\n"],
    ["jsx.tsx", "const view = (\n  <div>\n    {/* forbidden */}\n    <span />\n  </div>\n);\n"],
    ["shell.sh", "#!/bin/sh\n# forbidden\nexit 0\n"],
    ["config.yml", "# forbidden\nvalue: 1\n"],
  ])("still finds and removes comments in %s", (file, text) => {
    expect(remainingComments(file, text)).toHaveLength(1);
    const result = strip(file, text);
    expect(result.removed).toBe(1);
    expect(remainingComments(file, result.text)).toEqual([]);
  });

  it("rejects an inline JSX comment even when safe removal fails", () => {
    const text = "const view = <div>{/* forbidden */}</div>;\n";
    expect(remainingComments("inline.tsx", text)).toHaveLength(1);
    const folder = mkdtempSync(join(tmpdir(), "laterdog-inline-comment-"));
    const file = join(folder, "inline.tsx");
    writeFileSync(file, text);
    const result = spawnSync(process.execPath, [
      resolve("scripts/no-comments.ts"),
      "--check",
      file,
    ]);
    expect(result.status).toBe(1);
  });
});
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
