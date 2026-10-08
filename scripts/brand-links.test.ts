// later.dog is its own project. No tracked file names the project it started from: the one attribution the Apache
// License requires lives in NOTICE and nowhere else. Repository links point at github.com/woodbeary/later-dog.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Assembled from parts so that this file does not carry the names it guards against.
const FORMER_NAMES = new RegExp(
  [["open", "maus"], ["maus", "bot"], ["mil", "ind"], ["supa", "maus"], ["(?<![a-z])o", "mb(?:[-_.:](?=[a-z])|[0-9])"], ["(?<![A-Z])O", "MB_"], ["\\bo", "gb\\b"],
    ["\\.o", "mb[a-z]"], ["o", "mbbackup"]]
    .map((parts) => parts.join(""))
    .join("|"),
  "i",
);
// A dot instead of a hyphen names a repository that does not exist.
const WRONG_REPOSITORY = /github\.com\/woodbeary\/later\.dog\b/i;
const EXEMPT = new Set(["NOTICE", "scripts/brand-links.test.ts"]);

function offenders(pattern: RegExp): string[] {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter((file) => file && !EXEMPT.has(file));
  return files.flatMap((file) => {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return []; }
    return text.split("\n").flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : []));
  });
}

describe("later.dog's own names", () => {
  it("leaves no former project name in any tracked file but NOTICE", () => {
    expect(offenders(FORMER_NAMES), "Use later.dog's names; the attribution the license requires is in NOTICE.").toEqual([]);
  });

  it("links the repository as github.com/woodbeary/later-dog", () => {
    expect(offenders(WRONG_REPOSITORY), "The repository is github.com/woodbeary/later-dog (a hyphen, not a dot).").toEqual([]);
  });
});
