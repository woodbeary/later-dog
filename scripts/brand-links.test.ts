import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RETIRED_PARTS = new Set([
  "c14b10b3c1a29aad5231348388052e29100160b40eabc62638dc8b0872cb080a",
  "a82d92c43ec805af130d462152d4a1ab9941264bdf25516536e8d69ef263cf7e",
  "b10c6ccffda285cd7d54651fcd6a78f01ff780a9bf405c45dc197464d4654320",
  "8f8311527ee1a954e6afcaf60dabba97b42531ed9a084c22f052eb601bc7e6d4",
  "6cb784e0f985cba22d0642283892ad0f90dcd48385524de0dec0f51624456a43",
]);
const RETIRED_PART_LENGTHS = [6, 7, 8];
const RETIRED_PREFIXES = new Set(["42a9011e3cb58406e9a2c51582da15c6656144560403dd673dfead4f284f7e9b"]);
const RETIRED_PREFIX_LENGTH = 3;
const RETIRED_WORDS = new Set(["5d17f1bc6a0336a5762a53dcf00805cf973cf93b6b7fd74d6cc3551dae12be22"]);
const PAIR_STARTS = new Set([
  "add92b9cde2bdbf3daaf65a0db79e9b1a7fa428b71b4d6ce38c742eb6dca0c1c",
  "3e6558d0cb97f9bd3e8a25ae442f7ef7d95de26e56b6fd69df10be97e8a21563",
  "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6",
  "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4",
]);
const RETIRED_PAIRS = new Set([
  "bf5b1a77289a1fcacf2eb34c8c1ae7a0b6243b7c58437d175ff8ca1921e1021a",
  "911908ecfe67625dee5409a22110be143d0017912a952b9c7291edfa8aebc2af",
  "8ed084c0af636fe5b598077909fd8c8a378217f85929bb26f8712c4b088f6351",
  "b44ec872fa6b4f8fda7a835640dfa548ce6a0d2c363df8c28dbfc09bc6da3228",
  "ac5c45829107a0b7aa3dcd0feb7365b9ff65195ee1bb67fbbf20cca4a79aa9f2",
  "11625b0516e3cf97932da979341c74c970e4a787afa5526694fcc3a6187a5b09",
  "5d7bab990c33fb8a54677d2cfbcd85d538d41a0acb96d5686f4af806d8a79f47",
]);
const WRONG_REPOSITORY = /github\.com\/woodbeary\/later\.dog\b/i;
const EXEMPT = new Set(["NOTICE", "pnpm-lock.yaml"]);
const WORD = /[a-z0-9]+/g;

const digests = new Map<string, string>();
function digest(text: string): string {
  let known = digests.get(text);
  if (!known) {
    known = createHash("sha256").update(text).digest("hex");
    digests.set(text, known);
  }
  return known;
}

const retiredWordVerdicts = new Map<string, boolean>();
function retiredWord(word: string): boolean {
  let verdict = retiredWordVerdicts.get(word);
  if (verdict === undefined) {
    verdict = RETIRED_WORDS.has(digest(word))
      || (word.length >= RETIRED_PREFIX_LENGTH && RETIRED_PREFIXES.has(digest(word.slice(0, RETIRED_PREFIX_LENGTH))))
      || RETIRED_PART_LENGTHS.some((length) => {
        for (let start = 0; start + length <= word.length; start += 1) {
          if (RETIRED_PARTS.has(digest(word.slice(start, start + length)))) return true;
        }
        return false;
      });
    retiredWordVerdicts.set(word, verdict);
  }
  return verdict;
}

export function namesSomethingRetired(line: string): boolean {
  const words = line.toLowerCase().match(WORD) ?? [];
  return words.some((word, index) => retiredWord(word)
    || (index + 1 < words.length && PAIR_STARTS.has(digest(word)) && RETIRED_PAIRS.has(digest(`${word} ${words[index + 1]}`))));
}

function offenders(matches: (line: string) => boolean): string[] {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter((file) => file && !EXEMPT.has(file));
  return files.flatMap((file) => {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return []; }
    if (text.includes("\u0000") || text.includes("�")) return [];
    return text.split("\n").flatMap((line, index) => (matches(line) ? [`${file}:${index + 1}`] : []));
  });
}

describe("later.dog's own names", () => {
  it("names no former project, outside product, study or capture in any tracked file but NOTICE", () => {
    expect(offenders(namesSomethingRetired), "Describe later.dog on its own terms; the attribution the license requires is in NOTICE.").toEqual([]);
  });

  it("knows the words it keeps out without spelling them", () => {
    const spelled = (codes: number[]) => String.fromCharCode(...codes);
    expect(namesSomethingRetired(`see ${spelled([103, 114, 111, 107])} ${spelled([98, 111, 116])}'s sidebar`)).toBe(true);
    expect(namesSomethingRetired(`${spelled([84, 55])} study`)).toBe(true);
    expect(namesSomethingRetired(`the ${spelled([67])}-${spelled([76, 73, 86, 69])}-16 capture`)).toBe(true);
    expect(namesSomethingRetired(`${spelled([79, 77, 66])}_DATA_DIR`)).toBe(true);
    expect(namesSomethingRetired("Grok 4.3 answers when Kimi does not")).toBe(false);
    expect(namesSomethingRetired("tomb raider and a bomb squad")).toBe(false);
    expect(namesSomethingRetired('insertMessage("t7", msg("m1", "hi"))')).toBe(false);
  });

  it("links the repository as github.com/woodbeary/later-dog", () => {
    expect(offenders((line) => WRONG_REPOSITORY.test(line)), "The repository is github.com/woodbeary/later-dog (a hyphen, not a dot).").toEqual([]);
  });
});
