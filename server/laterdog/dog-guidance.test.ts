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
  homeKit,
  kitPrompt,
  medicationBlock,
  modelFamily,
  modelNotes,
  BETWEEN_DOGS,
  CHECKLIST_IN_REPLY,
  HELPER_BRIEF,
  NEEDS_PERSON,
  needsPerson,
  PRECEDENCE,
  ROUTINE_OFFER,
  SENDING,
  STAY_FREE,
  STOP_MEANS_STOP,
  ANSWER_IN_FIRST_SENTENCE,
  taskList,
  PAYMENTS_BLOCK,
  REPLY_STYLE,
  ROOM_TEAM_PROMPT,
  teammateTaskPrompt,
  type ModelFamily,
} from "./dog-guidance.ts";

const everything = () => [
  dogGuidance({ engine: "claude", model: "claude-fable-5-2", kit: { cloudHome: true, ownComputer: true, vault: true, github: true, google: true, mac: true } }),
  dogGuidance({ engine: "codex", model: "gpt-5.6" }),
  REPLY_STYLE,
  teammateTaskPrompt(true),
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
    expect(ANSWER_FIRST).toMatch(/say in one line what you are doing before your first tool call/);
    expect(ANSWER_FIRST).toMatch(/not what you do not know yet, and never fill the gap with an answer you have not checked/);
    expect(ANSWER_FIRST).toMatch(/one-line update at natural points/);
    expect(ANSWER_FIRST).toMatch(/If you stop before the work is done, say why in plain words/);
    expect(taskList("claude")).toMatch(/^Your task list \(TodoWrite\) is your queue, and the app shows the person your progress from it\. Add each thing they ask for when they ask it; something they want later goes on the list as not started\. Mark an item in progress when work begins, and done only after it was checked and they were told\./);
    expect(taskList("codex")).toMatch(/^Your task list \(update_plan\) is your queue/);
    expect(taskList("other")).toMatch(/^Your task list is your queue/);
    expect(taskList("claude")).toMatch(/on every new message and whenever a helper or a background command finishes; make checking the last item/);
    expect(taskList("claude")).toMatch(/"not live yet"/);
    expect(taskList("claude")).toMatch(/When they ask where things stand \(a status, a checkpoint, "where are we"\), answer from the list: done, in progress, not started/);
    expect(DECIDE_DONT_ASK).toMatch(/Make engineering choices yourself with current best practice/);
    expect(DECIDE_DONT_ASK).toMatch(/a secret, a tap on their device, money, or a preference/);
    expect(EVIDENCE_FIRST).toMatch(/this chat and its files, your memory and past chats .*, connected apps, the web, the signed-in browser, your computer/);
    expect(EVIDENCE_FIRST).toMatch(/ask the person last/);
    expect(CHECK_WORK).toMatch(/look at visual work yourself at its real size before you show it/);
    expect(CHECK_WORK).toMatch(/say plainly what you verified and what you assumed/);
    expect(CHECK_WORK).toMatch(/^Check your work before calling it done/);
    expect(FINISH_WORK).toMatch(/ordinary obstacles/);
    for (const line of [ANSWER_FIRST, FINISH_WORK, taskList("claude"), CHECK_WORK, DECIDE_DONT_ASK, EVIDENCE_FIRST, ACTING, needsPerson("claude"), SENDING, STAY_FREE, HELPER_BRIEF, STOP_MEANS_STOP, BETWEEN_DOGS, ROUTINE_OFFER, PRECEDENCE]) expect(text).toContain(line);
    expect(text).not.toContain(CHECKLIST_IN_REPLY);
    expect(dogGuidance({ engine: "codex", model: "gpt-5.6" })).toContain(taskList("codex"));
  });

  it("has an included model answer first, without a checklist, opener or unasked table", () => {
    const included = dogGuidance({ engine: "other", model: "kimi-k2.6" });
    expect(CHECKLIST_IN_REPLY).toBe("Keep track of everything the person asked for in this chat. When they ask where things stand, say what is done, what is in progress and what is not started.");
    expect(included).toContain(CHECKLIST_IN_REPLY);
    expect(included).not.toMatch(/Your task list|show it in your reply/);
    expect(included).toContain(`<model_notes>\n${ANSWER_IN_FIRST_SENTENCE}\n</model_notes>`);
    expect(ANSWER_IN_FIRST_SENTENCE).toBe("Answer in your first sentence. Do not open by restating the request or saying what you are about to do, and do not use a table or a list unless the content needs one or the person asked.");
    expect(dogGuidance({ engine: "claude", model: "kimi-k2.6" })).not.toContain(ANSWER_IN_FIRST_SENTENCE);
  });

  it("keeps the dog free to answer, briefs helpers well and stops everything on stop", () => {
    expect(STAY_FREE).toMatch(/if waiting on something would keep you from answering the person/);
    expect(STAY_FREE).toMatch(/say in one line that it started, and stay available; you are woken when it finishes/);
    expect(STAY_FREE).toMatch(/Send follow-ups on the same work to the same helper, and do quick things yourself/);
    expect(HELPER_BRIEF).toMatch(/the outcome, what is known, where to look and when to stop/);
    expect(HELPER_BRIEF).toMatch(/only its last message comes back, so that message starts with done, partial or blocked/);
    expect(HELPER_BRIEF).toMatch(/after two or three different failed attempts it stops and reports/);
    expect(STOP_MEANS_STOP).toMatch(/stop your helpers and background commands first, and say it has stopped only when nothing is still running/);
    expect(PRECEDENCE).toBe("A tool's description says how to use it; these instructions say when.");
  });

  it("asks with a card, takes a no as final and sends exactly what was asked", () => {
    expect(NEEDS_PERSON).toMatch(/raise it with a card tool that fits .*, so the app shows that you are waiting/);
    expect(NEEDS_PERSON).toMatch(/one question at a time, with real options/);
    expect(NEEDS_PERSON).toMatch(/A dismissed or declined card is a no: do not ask again or reach the same end another way/);
    expect(needsPerson("claude")).toMatch(/questions and choices go through AskUserQuestion, one at a time with real options; a secure form, take-over, device approval, credential request or proposal covers its own case/);
    expect(needsPerson("codex")).toMatch(/questions and choices go through request_user_input/);
    expect(needsPerson("other")).toBe(NEEDS_PERSON);
    for (const engine of ["claude", "codex"] as const) {
      expect(needsPerson(engine)).toMatch(/A dismissed or declined card is a no/);
      expect(dogGuidance({ engine, model: engine === "claude" ? "claude-opus-5-5" : "gpt-5.6" })).toContain(needsPerson(engine));
    }
    expect(SENDING).toMatch(/covers exactly that message to the people it names, once/);
    expect(ROUTINE_OFFER).toMatch(/Offer a routine in one sentence when a request recurs/);
    expect(ROUTINE_OFFER).toMatch(/with nothing new for the person, end without a message/);
    expect(BETWEEN_DOGS).toMatch(/message several about one thing only when the person asked for that/);
    expect(BETWEEN_DOGS).toMatch(/never their frustration/);
    expect(BETWEEN_DOGS).toMatch(/do not answer a thank-you or an FYI/);
  });

  it("writes replies the way the person reads them", () => {
    for (const rule of [/Match their length, in whole sentences, not clipped fragments/, /times in their time zone/, /Do not guess a name from an email address or handle/,
      /Never make up numbers, quotes, sources or where something is in the app, and label example data as an example/, /Use what you remember only where it changes the answer, without announcing/]) {
      expect(REPLY_STYLE).toMatch(rule);
    }
  });

  it("tells a delegated dog what it already has instead of letting it ask", () => {
    const kit = kitPrompt({ cloudHome: true, ownComputer: true, vault: true, github: true, google: true, mac: true });
    expect(kit).toMatch(/your own cloud computer .*run_on_computer/);
    expect(kit).toMatch(/the vault \(vault_secret\)/);
    expect(kit).toMatch(/GitHub, signed in on this home/);
    expect(kit.endsWith("Use these before asking the person for a sign-in or for their Mac.")).toBe(true);
    expect(kit).not.toMatch(/approval/);
    expect(kitPrompt({ ownComputer: true })).not.toMatch(/GitHub|vault/);
    expect(kitPrompt({})).toBe("");
    expect(kitPrompt(undefined)).toBe("");
  });

  it("keeps the person's no in work another dog hands over, and waives a second ask only with the owner's authority", () => {
    const owned = teammateTaskPrompt(true);
    const peer = teammateTaskPrompt(false);
    for (const prompt of [owned, peer]) {
      expect(prompt).toMatch(/^Do the request below in this conversation/);
      expect(prompt).toContain("A no from the person stays a no.");
    }
    expect(owned).toMatch(/is not too risky to do: .*do not ask again for an approval the request already carries/);
    expect(peer).not.toMatch(/not too risky|do not ask again for an approval/);
  });

  it("claims a Mac only while one is connected to the home", () => {
    const home = { cloudHome: true, agents: true, vault: true };
    const signedOut = () => false;
    expect(homeKit({ ...home, macsOnline: 0 }, signedOut).mac).toBe(false);
    expect(kitPrompt(homeKit({ ...home, macsOnline: 0 }, signedOut))).not.toMatch(/Mac through/);
    expect(kitPrompt(homeKit({ ...home, macsOnline: 1 }, signedOut))).toMatch(/a lent Mac through shared_computer/);
    expect(homeKit({ ...home, cloudHome: false, macsOnline: 1 }, () => true)).toMatchObject({ mac: false, github: false, ownComputer: false });
  });

  it("reads the home's GitHub sign-in from the token or a gh login file that names a user or token", () => {
    const home = mkdtempSync(join(tmpdir(), "guidance-gh-"));
    const hosts = (text: string) => writeFileSync(join(home, ".config", "gh", "hosts.yml"), text);
    try {
      expect(homeGitHubSignedIn({}, home)).toBe(false);
      expect(homeGitHubSignedIn({ GH_TOKEN: "x" }, home)).toBe(true);
      mkdirSync(join(home, ".config", "gh"), { recursive: true });
      for (const loggedOut of ["{}\n", "", "github.com: {}\n", "github.com:\n    git_protocol: https\n"]) {
        hosts(loggedOut);
        expect([loggedOut, homeGitHubSignedIn({}, home)]).toEqual([loggedOut, false]);
      }
      hosts("github.com:\n    user: sam\n    git_protocol: https\n");
      expect(homeGitHubSignedIn({}, home)).toBe(true);
      hosts("github.com:\n    users:\n        sam:\n            oauth_token: x\n");
      expect(homeGitHubSignedIn({}, home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves approvals to the person's setting and keeps a yes for hard-to-undo, visible or paid actions", () => {
    expect(ACTING).toMatch(/Your approval setting decides which actions wait for the person's yes/);
    expect(ACTING).toMatch(/hard to undo, visible to other people \(sending, posting, publishing\) or that spends money/);
    expect(ACTING.endsWith("Once the person has said yes to a piece of work, do not ask again for the same thing.")).toBe(true);
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
    expect(fable).toMatch(/offering to wait or asking whether to go on, do the next part instead/);
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
    expect(Buffer.byteLength(main) - Buffer.byteLength(PAYMENTS_BLOCK)).toBeLessThan(6_300);
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
