import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HELPER_CONTRACT, helperContractArgs, SUBAGENT_PROMPT_FLAG } from "./helper-contract.ts";

describe("what every helper is told about reporting", () => {
  it("says who it works for, that it finishes alone, how its last message starts and when it stops", () => {
    const sentences = HELPER_CONTRACT.split(/(?<=\.) /);
    expect(sentences).toHaveLength(4);
    expect(sentences[0]).toBe("You are a helper doing one part of a larger job for one of the person's dogs.");
    expect(sentences[1]).toBe("Finish it on your own: you cannot ask the person anything, and only your last message goes back to the dog.");
    expect(sentences[2]).toMatch(/^Begin that message with done, partly done or blocked, then say what you checked yourself and what you took on trust/);
    expect(sentences[3]).toBe("If two or three different attempts fail, stop and report blocked with what you tried.");
  });

  it("writes the rules to a private file next to the dog's own instructions", () => {
    const dir = mkdtempSync(join(tmpdir(), "helper-contract-"));
    try {
      const args = helperContractArgs(dir);
      expect(args).toEqual([SUBAGENT_PROMPT_FLAG, join(dir, "helpers.txt")]);
      expect(readFileSync(args[1]!, "utf8")).toBe(HELPER_CONTRACT);
      expect(statSync(args[1]!).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
