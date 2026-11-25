import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkedComments, remainingComments } from "./no-comments.ts";

describe("native comment check parse failures", () => {
  it.each(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"])(
    "rejects malformed %s even without a comment opener",
    (extension) => {
      const folder = mkdtempSync(join(tmpdir(), "laterdog-invalid-comment-check-"));
      const file = join(folder, `invalid.${extension}`);
      writeFileSync(file, "export const invalid = ;\n");
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/no-comments.ts"), "--check", file],
        {
          encoding: "utf8",
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain("cannot parse");
    },
  );
});

const vectors: Array<[string, string, number]> = [
  ["plain.ts", "export const value = 1;\n", 0],
  ["strings.ts", 'const value = "// text /* text */";\n', 0],
  ["template.ts", "const value = `// text ${1} /* text */`;\n", 0],
  ["template-comment.ts", "const value = `// text ${/* forbidden */ 1}`;\n", 1],
  ["regexp.js", "const value = /\\/\\//g;\n", 0],
  ["regexp.ts", "const value = /[/][*]/;\n", 0],
  ["view.tsx", "const value = <p>// text /* text */</p>;\n", 0],
  ["view.jsx", "const value = <p>{/* forbidden */}</p>;\n", 1],
  ["view.tsx", "const value = <>text{/* forbidden */}<span /></>;\n", 1],
  ["line.ts", "const value = 1; // forbidden\n", 1],
  ["block.ts", "/* first */ const value = 1; // second\n", 2],
  ["types.mts", "export type Value = { label: string }; // forbidden\n", 1],
  ["types.cts", "export = 1; // forbidden\n", 1],
  ["module.mjs", 'import { value } from "./value.mjs"; // forbidden\n', 1],
  ["common.cjs", "module.exports = 1; // forbidden\n", 1],
  ["common.cjs", "return;\n", 0],
  ["unicode.ts", 'const value = "🐕"; // forbidden\n', 1],
  ["directive.ts", "// @ts-expect-error\nconst value = missing;\n", 0],
  ["directive.ts", "/* oxlint-disable no-console */\nconsole.log(1);\n", 0],
  ["reference.ts", '/// <reference path="./value.d.ts" />\nexport {};\n', 0],
  ["license.ts", "/*! Licence notice */\nexport const value = 1;\n", 0],
  ["license.ts", "// Copyright 2026 Someone\n// Licence terms stay together.\nexport {};\n", 0],
  ["mixed.ts", "// Copyright 2026 Someone\n\n// forbidden\nexport {};\n", 1],
  ["shebang.mjs", "#!/usr/bin/env node\nexport const value = 1;\n", 0],
  ["shebang.cts", "#!/usr/bin/env node\nmodule.exports = 1; // forbidden\n", 1],
  ["shell.sh", "#!/bin/sh\n# forbidden\nexit 0\n", 1],
  ["scripts/git-hooks/pre-push", "#!/bin/sh\n# forbidden\nexit 0\n", 1],
  ["Dockerfile", "# syntax=docker/dockerfile:1\n# forbidden\nFROM alpine\n", 1],
  ["config.yml", 'value: "# text"\n# forbidden\n', 1],
  ["config.jsonc", '{"value":"// text"} // forbidden\n', 1],
  ["style.css", 'a { content: "/* text */"; } /* forbidden */\n', 1],
  ["native.rs", 'const VALUE: &str = r#"// text"#; // forbidden\n', 1],
];

describe("native comment classification", () => {
  it.each(vectors)("preserves the %s comment verdict", (file, text, count) => {
    const old = remainingComments(file, text);
    expect(old).toHaveLength(count);
    expect(checkedComments(file, text)).toEqual(old);
  });

  it("reports every file when parse failures and forbidden comments share one check", () => {
    const folder = mkdtempSync(join(tmpdir(), "laterdog-collect-comment-errors-"));
    const first = join(folder, "first.ts");
    const second = join(folder, "second.tsx");
    const noted = join(folder, "noted.mjs");
    writeFileSync(first, "export const invalid = ;\n");
    writeFileSync(second, "export const invalid = ;\n");
    writeFileSync(noted, "export const value = 1; // forbidden\n");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/no-comments.ts"), "--check", first, second, noted],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(first);
    expect(result.stdout).toContain(second);
    expect(result.stdout).toContain("would remove 1 comments in 1 files");
  });
});
