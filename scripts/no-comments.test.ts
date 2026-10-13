import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { remainingComments, strip, trackedFiles } from "./no-comments.ts";

describe("later.dog's code has no comments", () => {
  it("leaves only what tools read and the licence notices other code came with", { timeout: 180_000 }, () => {
    const found = trackedFiles().flatMap((file) =>
      remainingComments(file, readFileSync(file, "utf8")).map((comment) => `${file}:${comment.line} ${comment.text}`),
    );
    expect(found, "Say it in code, names and tests. node scripts/no-comments.ts --write removes them.").toEqual([]);
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
});
