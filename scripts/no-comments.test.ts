import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remainingComments, strip, trackedFiles } from "./no-comments.ts";

describe("later.dog's code has no comments", () => {
  it("leaves only what tools read and the licence notices other code came with", { timeout: 180_000 }, () => {
    const found = trackedFiles().flatMap((file) =>
      remainingComments(file, readFileSync(file, "utf8")).map((comment) => `${file}:${comment.line} ${comment.text}`),
    );
    expect(found, "Say it in code, names and tests. node scripts/no-comments.ts --write removes them.").toEqual([]);
  });

  it("stops a push that brings comments in, and lets a clean one through", () => {
    const folder = mkdtempSync(join(tmpdir(), "no-comments-"));
    try {
      writeFileSync(join(folder, "noted.ts"), "export const answer = 42; // the answer\n");
      writeFileSync(join(folder, "clean.ts"), "export const answer = 42;\n");
      const check = (file: string) => spawnSync(process.execPath, ["scripts/no-comments.ts", "--check", join(folder, file)], { encoding: "utf8" });
      const noted = check("noted.ts");
      expect(noted.status).toBe(1);
      expect(noted.stdout).toContain("node scripts/no-comments.ts --write removes them");
      expect(check("clean.ts").status).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("removing comments", () => {
  it("removes whole-line, trailing and doc comments and keeps the code", () => {
    const before = "/** What a dog is called. */\nexport const name = \"Biscuit\"; // the default\n\n// Greets.\nexport function greet() {\n  return `hi ${name}`;\n}\n";
    expect(strip("a.ts", before).text).toBe("export const name = \"Biscuit\";\n\nexport function greet() {\n  return `hi ${name}`;\n}\n");
  });

  it("never reads strings, templates, regular expressions or JSX text as comments", () => {
    const before = 'const url = "https://later.dog"; const re = /\\/\\/x/;\nconst t = `// ${url} /* not one */`;\nconst el = <p>// shown as text</p>;\n';
    expect(strip("a.tsx", before)).toEqual({ text: before, removed: 0 });
  });

  it("keeps directives tools read and licence notices", () => {
    const environment = ["@vitest", "environment happy-dom"].join("-");
    const before = `// ${environment}\n// MIT License, Copyright (c) 2026 Someone\n// eslint-disable-next-line no-console\nconsole.log(1);\n`;
    expect(strip("a.test.ts", before)).toEqual({ text: before, removed: 0 });
  });

  it("drops a JSX comment's braces and empties a block that held only a comment", () => {
    expect(strip("a.tsx", "const a = (\n  <div>\n    {/* the pill */}\n    <span />\n  </div>\n);\n").text).toBe("const a = (\n  <div>\n    <span />\n  </div>\n);\n");
    expect(strip("a.ts", "try {\n  run();\n} catch {\n  // nothing to undo\n}\n").text).toBe("try {\n  run();\n} catch {}\n");
  });

  it("keeps the line break a comment carried, so return still ends the statement", () => {
    expect(strip("a.ts", "function f() {\n  return /* a\n  b */ 1;\n}\n").text).toBe("function f() {\n  return\n1;\n}\n");
  });

  it("handles YAML, keeping quoted hashes and here-documents in run blocks", () => {
    const workflow = [
      "# Explains the job.",
      "name: ci",
      "on: [push] # every push",
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: \"Tag #1\"",
      "        run: |",
      "          # say why",
      "          echo '# kept'",
      "          cat <<'EOF'",
      "          # data, not a comment",
      "          EOF",
      "      - name: notes",
      "        with:",
      "          body: |",
      "            # A heading in a string",
      "",
    ].join("\n");
    expect(strip(".github/workflows/a.yml", workflow).text).toBe([
      "name: ci",
      "on: [push]",
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: \"Tag #1\"",
      "        run: |",
      "          echo '# kept'",
      "          cat <<'EOF'",
      "          # data, not a comment",
      "          EOF",
      "      - name: notes",
      "        with:",
      "          body: |",
      "            # A heading in a string",
      "",
    ].join("\n"));
  });

  it("handles JSON with comments, SQL, markup and hash-commented config files", () => {
    expect(strip("wrangler.jsonc", "{\n  // the name\n  \"name\": \"a//b\", /* why */\n  \"n\": 1,\n}\n").text).toBe("{\n  \"name\": \"a//b\",\n  \"n\": 1,\n}\n");
    expect(strip("m.sql", "-- adds a column\nALTER TABLE t ADD c TEXT DEFAULT '--not'; -- why\n").text).toBe("ALTER TABLE t ADD c TEXT DEFAULT '--not';\n");
    expect(strip("a.xml", "<?xml version=\"1.0\"?>\n<!-- why -->\n<a/>\n").text).toBe("<?xml version=\"1.0\"?>\n<a/>\n");
    expect(strip("deploy/Caddyfile", "# serves the app\n:8080 {\n  respond \"#ok\"\n}\n").text).toBe(":8080 {\n  respond \"#ok\"\n}\n");
    expect(strip("a.apparmor", "#include <tunables/global>\n# why\nprofile a {}\n").text).toBe("#include <tunables/global>\nprofile a {}\n");
  });

  it("handles stylesheets and shell scripts, leaving shebangs and here-documents alone", () => {
    expect(strip("a.css", "/* card */\n.card { color: red; /* brand */ }\n/*! keep */\n").text).toBe(".card { color: red; }\n/*! keep */\n");
    const script = "#!/bin/bash\n# Explains.\nset -e\ncat <<'EOF'\n# data, not a comment\nEOF\n";
    expect(strip("a.sh", script).text).toBe("#!/bin/bash\nset -e\ncat <<'EOF'\n# data, not a comment\nEOF\n");
  });

  it("handles Rust, leaving strings, raw strings, characters and lifetimes alone", () => {
    const before = [
      "// Walks the home.",
      "/// Names a thing.",
      "fn name<'a>(text: &'a str) -> &'a str {",
      "    let url = \"https://later.dog\"; // why",
      "    let raw = r#\"// not \"one\" /* either */\"#;",
      "    let bytes = br\"// kept\";",
      "    let slash = '/';",
      "    let quote = '\\'';",
      "    let escaped = \"a \\\" // kept\";",
      "    /* outer /* nested */ still a comment */",
      "    text",
      "}",
      "",
    ].join("\n");
    const after = [
      "fn name<'a>(text: &'a str) -> &'a str {",
      "    let url = \"https://later.dog\";",
      "    let raw = r#\"// not \"one\" /* either */\"#;",
      "    let bytes = br\"// kept\";",
      "    let slash = '/';",
      "    let quote = '\\'';",
      "    let escaped = \"a \\\" // kept\";",
      "    text",
      "}",
      "",
    ].join("\n");
    expect(strip("a.rs", before)).toEqual({ text: after, removed: 4 });
    expect(strip("a.rs", after)).toEqual({ text: after, removed: 0 });
    expect(remainingComments("a.rs", "fn main() {} // why\n")).toEqual([{ line: 1, text: "// why" }]);
    const licensed = "// SPDX-License-Identifier: MIT\nfn main() {}\n";
    expect(strip("a.rs", licensed)).toEqual({ text: licensed, removed: 0 });
  });

  it("handles a Cargo manifest, leaving hashes inside its strings alone", () => {
    const before = [
      "# Builds the walker.",
      "[package]",
      "name = \"save-walk\" # the binary",
      "description = \"lists # and hashes\"",
      "homepage = 'https://later.dog/#save'",
      "",
      "[dependencies]",
      "sha2 = { version = \"0.10\", features = [\"asm\"] } # faster",
      "notes = \"\"\"",
      "# kept, inside a multi-line string",
      "\"\"\"",
      "escaped = \"a \\\" # kept\"",
      "",
    ].join("\n");
    const after = [
      "[package]",
      "name = \"save-walk\"",
      "description = \"lists # and hashes\"",
      "homepage = 'https://later.dog/#save'",
      "",
      "[dependencies]",
      "sha2 = { version = \"0.10\", features = [\"asm\"] }",
      "notes = \"\"\"",
      "# kept, inside a multi-line string",
      "\"\"\"",
      "escaped = \"a \\\" # kept\"",
      "",
    ].join("\n");
    expect(strip("crate/Cargo.toml", before)).toEqual({ text: after, removed: 3 });
    expect(strip("crate/Cargo.toml", after)).toEqual({ text: after, removed: 0 });
    expect(remainingComments("crate/Cargo.toml", "strip = true # smaller\n")).toEqual([{ line: 1, text: "# smaller" }]);
  });
});

describe("what the check reads", () => {
  const read = (file: string) => trackedFiles().includes(file);

  it("reads every language the Rust measurements are written in", () => {
    const measurements = spawnSync("git", ["ls-files", "prototypes/rust-seam"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    expect(measurements.some((file) => file.endsWith(".rs"))).toBe(true);
    expect(measurements.some((file) => file.endsWith("/Cargo.toml"))).toBe(true);
    expect(measurements.filter((file) => !read(file)).filter((file) => !file.endsWith("/Cargo.lock"))).toEqual([]);
  });

  it("leaves out the lock files Cargo and pnpm write", () => {
    expect(read("pnpm-lock.yaml")).toBe(false);
    expect(trackedFiles().filter((file) => file.endsWith("Cargo.lock"))).toEqual([]);
  });
});
