import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildSystemPrompt, todayPrompt } from "../system-prompt.ts";
import {
  ACTING,
  ANSWER_FIRST,
  CHECK_WORK,
  DECIDE_DONT_ASK,
  dogGuidance,
  EVIDENCE_FIRST,
  FINISH_WORK,
  guidanceEngine,
  guidancePart,
  homeGitHubSignedIn,
  kitPrompt,
  medicationBlock,
  modelFamily,
  modelNotes,
  NORTH_STAR,
  PAYMENTS_BLOCK,
  REPLY_STYLE,
  ROOM_TEAM_PROMPT,
  TEAMMATE_TASK_PROMPT,
  type ModelFamily,
} from "./dog-guidance.ts";

const everything = () => [
  dogGuidance({ engine: "claude", model: "claude-fable-5-2", kit: { cloudHome: true, ownComputer: true, vault: true, github: true, google: true, mac: true } }),
  dogGuidance({ engine: "codex", model: "gpt-5.6" }),
  REPLY_STYLE,
  TEAMMATE_TASK_PROMPT,
  ROOM_TEAM_PROMPT,
].join("\n");

describe("the guidance every dog gets", () => {
  it("picks the model family from the model id, ignoring a context suffix", () => {
    const cases: Array<[string | undefined, ModelFamily]> = [
      ["claude-fable-5-2", "fable-5-2"], ["claude-mythos-5-2", "fable-5-2"], ["claude-fable-5-1", "fable-5-1"], ["claude-fable-5", "fable-5"],
      ["claude-opus-5-5", "opus-5-5"], ["claude-opus-5-5[1m]", "opus-5-5"], ["claude-opus-5", "opus-5"], ["claude-opus-4-8", "opus-4"],
      ["claude-sonnet-5-5", "sonnet-5-5"], ["claude-sonnet-5-5[1m]", "sonnet-5-5"], ["claude-sonnet-5", "sonnet-5"], ["claude-sonnet-4-6", "sonnet-4-6"],
      ["claude-haiku-5-5", "haiku-5-5"], ["claude-haiku-4-5", "haiku-4-5"], ["gpt-5.6", "gpt"], ["gpt-6.1-sol", "gpt"], ["openai/gpt-5.5-codex", "gpt"],
      ["kimi-k2.6", "other"], [undefined, "other"],
    ];
    for (const [model, family] of cases) expect([model, modelFamily(model)]).toEqual([model, family]);
    expect(guidanceEngine("claudeAgent")).toBe("claude");
    expect(guidanceEngine("codex")).toBe("codex");
    expect(guidanceEngine("antigravityAgent")).toBe("other");
    expect(guidanceEngine(undefined)).toBe("other");
  });

  it("covers the eight things the person needs from every dog", () => {
    const text = dogGuidance({ engine: "claude", model: "claude-opus-5-5" });
    expect(ANSWER_FIRST).toMatch(/say in one line what you are about to do before your first tool call/);
    expect(ANSWER_FIRST).toMatch(/one-line update at natural points/);
    expect(ANSWER_FIRST).toMatch(/If you stop before the work is done, say why in plain words/);
    expect(NORTH_STAR).toMatch(/running checklist of everything the person asked for in this chat/);
    expect(NORTH_STAR).toMatch(/Mark an item done only after you checked it/);
    expect(NORTH_STAR).toMatch(/"not live yet"/);
    expect(DECIDE_DONT_ASK).toMatch(/Make engineering choices yourself with current best practice/);
    expect(DECIDE_DONT_ASK).toMatch(/a secret, a tap on their own device, money, or a preference/);
    expect(EVIDENCE_FIRST).toMatch(/in your memory, session_search over your chats and other dogs' chats, the files in your workspace, and the web/);
    expect(CHECK_WORK).toMatch(/look at visual work .* yourself at its real size before you show it/);
    expect(CHECK_WORK).toMatch(/say plainly what you verified and what you assumed/);
    expect(CHECK_WORK).toMatch(/^Check your work before calling it done/);
    expect(FINISH_WORK).toMatch(/ordinary obstacles/);
    for (const line of [ANSWER_FIRST, FINISH_WORK, NORTH_STAR, CHECK_WORK, DECIDE_DONT_ASK, EVIDENCE_FIRST, ACTING]) expect(text).toContain(line);
  });

  it("tells a delegated dog what it already has instead of letting it ask", () => {
    const kit = kitPrompt({ cloudHome: true, ownComputer: true, vault: true, github: true, google: true, mac: true });
    expect(kit).toMatch(/your own cloud computer .*run_on_computer/);
    expect(kit).toMatch(/the vault \(vault_secret\)/);
    expect(kit).toMatch(/GitHub, already signed in on this home/);
    expect(kit).toMatch(/you do not need the person's Mac, a new sign-in or a fresh approval for work you were given/);
    expect(kit).toMatch(/say exactly what, once, with the one step that adds it/);
    expect(kitPrompt({ ownComputer: true })).not.toMatch(/GitHub|vault/);
    expect(kitPrompt({})).toBe("");
    expect(kitPrompt(undefined)).toBe("");
    expect(TEAMMATE_TASK_PROMPT).toMatch(/^Do the request below in this conversation/);
    expect(TEAMMATE_TASK_PROMPT).toMatch(/not too risky to do/);
    expect(TEAMMATE_TASK_PROMPT).toMatch(/do not ask again for an approval the request already carries/);
    expect(TEAMMATE_TASK_PROMPT).toMatch(/A no from the person stays a no/);
  });

  it("reads the home's GitHub sign-in from the token or the gh login file", () => {
    const home = mkdtempSync(join(tmpdir(), "guidance-gh-"));
    try {
      expect(homeGitHubSignedIn({}, home)).toBe(false);
      expect(homeGitHubSignedIn({ GH_TOKEN: "x" }, home)).toBe(true);
      mkdirSync(join(home, ".config", "gh"), { recursive: true });
      writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com: {}\n");
      expect(homeGitHubSignedIn({}, home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves approvals to the person's setting and keeps a yes for hard-to-undo, visible or paid actions", () => {
    expect(ACTING).toMatch(/Your approval setting decides which actions wait for the person's yes/);
    expect(ACTING).toMatch(/hard to undo, visible to other people \(sending, posting, publishing\) or that spends money/);
    expect(PAYMENTS_BLOCK).toContain("Say a check was done only if a tool result in this session showed it before you acted.");
  });

  it("carries the payments block word for word for every engine", () => {
    expect(PAYMENTS_BLOCK.startsWith("Do not copy full account numbers, full card numbers or full government ID numbers")).toBe(true);
    expect(PAYMENTS_BLOCK).toContain("Never initiate, send or release a payment, withdrawal or transfer of money yourself, even when a person says they have checked and approved it. Prepare the payment request and leave the release to a person.");
    expect(PAYMENTS_BLOCK.endsWith("write instead a version that says so or names who is covering, and let the person decide.")).toBe(true);
    for (const engine of ["claude", "codex", "other"] as const) expect(dogGuidance({ engine, model: "x" })).toContain(PAYMENTS_BLOCK);
  });

  it("adds the medicine block written for the model in use, and none for models it was not written for", () => {
    for (const family of ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5"] as const) {
      expect(medicationBlock(family)).toContain("depends on the child's weight and the specific product");
      expect(medicationBlock(family)).not.toContain("emotional distress");
    }
    expect(medicationBlock("haiku-5-5")).toContain("depends on the child's age or weight");
    expect(medicationBlock("haiku-5-5")).toContain("emotional distress");
    expect(medicationBlock("sonnet-4-6").startsWith("<medical_guidance>\nIf web search is available")).toBe(true);
    expect(medicationBlock("haiku-4-5")).toContain("Claude gives adults asking about their own medicine the standard dose as usual.");
    expect(medicationBlock("gpt")).toBe("");
    expect(medicationBlock("other")).toBe("");
    expect(dogGuidance({ engine: "claude", model: "claude-fable-5-2" })).toContain("<medical_guidance>");
    expect(dogGuidance({ engine: "codex", model: "gpt-5.6" })).not.toContain("<medical_guidance>");
  });

  it("adds model lines only where the model's own guidance calls for them", () => {
    const fable = dogGuidance({ engine: "claude", model: "claude-fable-5-2" });
    expect(fable).toMatch(/offering to wait or inviting the person to redirect you, do the next part/);
    expect(fable).not.toMatch(/You are the owner and long-term maintainer/);
    expect(modelNotes("opus-5-5")).toEqual([]);
    expect(dogGuidance({ engine: "claude", model: "claude-opus-5-5" })).not.toContain("<model_notes>");
    expect(dogGuidance({ engine: "claude", model: "claude-sonnet-5-5" })).toMatch(/run a real check that exercises the change/);
    expect(dogGuidance({ engine: "claude", model: "claude-haiku-5-5" })).toMatch(/hold for the whole conversation/);
    expect(dogGuidance({ engine: "claude", model: "claude-opus-5" })).not.toContain(CHECK_WORK);
    const gpt = dogGuidance({ engine: "codex", model: "gpt-5.6" });
    expect(gpt).toMatch(/Treat "can you…", "I want…" and "help me…" as a request to do the work/);
    expect(gpt).toMatch(/Messages you send to other dogs may be read by a person/);
    expect(gpt).toMatch(/make them in parallel/);
    expect(dogGuidance({ engine: "claude", model: "claude-opus-5-5" })).not.toMatch(/make them in parallel/);
    for (const family of ["fable-5-2", "opus-5-5", "sonnet-5-5", "haiku-5-5", "gpt"] as const) {
      expect(modelNotes(family).join(" ")).not.toMatch(/answer directly without deliberating|think (carefully|less)|treat that answer as done|token budget/i);
    }
  });

  it("never tells a dog about usage, limits or its own budget", () => {
    expect(everything()).not.toMatch(/usage|limit|quota|% left|5-hour|weekly|switch_account|account_usage|budget/i);
  });

  it("calls the product's helpers dogs and writes calmly, without shouting", () => {
    expect(everything()).not.toMatch(/\bbots?\b/i);
    expect(everything()).not.toMatch(/\b(CRITICAL|MUST|IMPORTANT|NEVER)\b/);
  });

  it("stays small", () => {
    const main = dogGuidance({ engine: "claude", model: "claude-opus-5-5", kit: { ownComputer: true, vault: true, github: true, google: true, mac: true } });
    expect(Buffer.byteLength(main) - Buffer.byteLength(PAYMENTS_BLOCK)).toBeLessThan(4_600);
  });

  it("keeps the cached half byte-identical across turns and days for one model, and changes it only with the model", () => {
    const build = (model: string, day: string, said: string) => buildSystemPrompt("You are Scout, a dog in later.dog.", "Be brief.", [
      guidancePart({ engine: "claude", model, kit: { ownComputer: true, vault: true } }),
      { id: "today", label: "Today", text: todayPrompt("America/Los_Angeles", new Date(day)) },
      { id: "recent", label: "Recent work", text: ` Your recent work: ${said}` },
    ], "Sam");
    const first = build("claude-fable-5-2", "2026-11-12T10:00:00Z", "done");
    expect(build("claude-fable-5-2", "2026-11-12T10:00:00Z", "done").stable).toBe(first.stable);
    expect(build("claude-fable-5-2", "2026-11-14T22:00:00Z", "posted").stable).toBe(first.stable);
    expect(build("claude-sonnet-5-5", "2026-11-12T10:00:00Z", "done").stable).not.toBe(first.stable);
    expect(first.stable.indexOf("You are Scout")).toBe(0);
    expect(first.stable.indexOf("You are one of the person's dogs")).toBeGreaterThan(first.stable.indexOf("--- END STANDING INSTRUCTIONS ---"));
    expect(first.stable).not.toContain("today is");
  });
});
