import { describe, expect, it } from "vitest";
import type { NativeRun } from "./native-runs.ts";
import {
  activityKindOfTool, ageWords, foldSentence, goingWords, helpersLine, lastMovedWords, liveStep, outcomeKindOfTool,
  sideJobsStillGoing, sideJobsWords, stepLabel, stepPhrase, stepTime, type ActivityKind, type OutcomeKind,
} from "./step-words.ts";

describe("tool names", () => {
  const tools: Array<[string, OutcomeKind, ActivityKind]> = [
    ["Bash", "command", "running"],
    ["mcp__agents__run_on_computer", "cloud", "running"],
    ["BashOutput", "check", "running"],
    ["KillShell", "command", "running"],
    ["mac_run_command", "command", "running"],
    ["Read", "read", "reading"],
    ["mac_read_file", "read", "reading"],
    ["Write", "wrote", "writing"],
    ["Edit", "edit", "editing"],
    ["apply_patch", "edit", "editing"],
    ["delete_file", "delete", "editing"],
    ["Grep", "search", "searching"],
    ["Glob", "search", "searching"],
    ["mcp__agents__session_search", "chats", "searching"],
    ["WebSearch", "web", "web"],
    ["WebSearch: pickup times", "web", "web"],
    ["WebFetch", "page", "page"],
    ["browser_navigate", "open", "page"],
    ["mcp__computer__screenshot", "screen", "screen"],
    ["mcp__computer__click", "computer", "computer"],
    ["browser_click", "computer", "computer"],
    ["mcp__agents__shared_computer", "computer", "computer"],
    ["coordinate_bots", "team", "team"],
    ["ListAgents", "team", "team"],
    ["read_phone", "phone", "working"],
    ["create_bot", "dog", "working"],
    ["memory_update", "note", "working"],
    ["TodoWrite", "plan", "working"],
    ["Task", "help", "working"],
    ["Agent", "help", "working"],
    ["send_email", "tool", "working"],
    ["ToolSearch", "tool", "working"],
  ];

  it.each(tools)("sorts %s into what it did and what it is doing", (name, outcome, activity) => {
    expect(outcomeKindOfTool(name)).toBe(outcome);
    expect(activityKindOfTool(name)).toBe(activity);
  });
});

describe("live phrases", () => {
  it.each([
    ["running", "claude-tool-a1", "Checking the result"],
    ["running", "claude-tool-b2", "Checking the result"],
    ["thinking", "claude-block-x", "Thinking it over"],
    ["screen", "claude-tool-c3", "Taking a look"],
    ["reading", "codex:item:7", "Doing some reading"],
    ["editing", "claude-tool-d4", "Tidying it up"],
  ] as Array<[ActivityKind, string, string]>)("picks the same %s phrase for %s every time", (kind, id, phrase) => {
    expect(stepPhrase(kind, id)).toBe(phrase);
    expect(stepPhrase(kind, id)).toBe(stepPhrase(kind, id));
  });

  it.each([
    ["thinking", ["Thinking it over", "Working it out", "Sorting it out"]],
    ["reading", ["Doing some reading", "Reading it through", "Going through it"]],
    ["writing", ["Writing it up", "Putting it into words"]],
    ["editing", ["Making changes", "Tidying it up"]],
    ["running", ["Trying it out", "Checking the result"]],
    ["searching", ["Looking around", "Digging through it"]],
    ["web", ["Looking it up", "Reading up on it"]],
    ["page", ["Looking it up", "Reading up on it"]],
    ["screen", ["Looking at the screen", "Taking a look", "Clicking around"]],
    ["computer", ["Looking at the screen", "Taking a look", "Clicking around"]],
    ["team", ["Checking in with the others"]],
    ["working", ["Working on it"]],
  ] as Array<[ActivityKind, string[]]>)("draws %s phrases only from its own list", (kind, phrases) => {
    const seen = new Set(Array.from({ length: 60 }, (_, index) => stepPhrase(kind, `step-${index}`)));
    expect([...seen].sort()).toEqual([...phrases].sort());
  });
});

describe("times", () => {
  it.each([
    [-5, null], [0, null], [59_999, null], [60_000, "for 1 min"], [3_599_999, "for 59 min"],
    [3_600_000, "for 1 hr"], [3_900_000, "for 1 hr 5 min"], [7_200_000, "for 2 hr"], [7_259_999, "for 2 hr"],
  ] as Array<[number, string | null]>)("says how long a step has gone after %d ms", (ms, words) => {
    expect(ageWords(ms)).toBe(words);
  });

  it.each([
    [0, "just now"], [59_999, "just now"], [60_000, "1 min ago"], [240_000, "4 min ago"],
    [3_599_999, "59 min ago"], [3_600_000, "1 hr ago"], [3 * 3_600_000 + 59 * 60_000, "3 hr ago"],
  ] as Array<[number, string]>)("says when work last moved %d ms ago", (ms, words) => {
    expect(lastMovedWords(ms)).toBe(words);
  });

  it("says how long a side job has been going, in plain units", () => {
    expect(goingWords(59_999)).toBe("Just started");
    expect(goingWords(360_000)).toBe("Going for 6 min");
    expect(goingWords(3_900_000)).toBe("Going for 1 hr 5 min");
    expect(`${goingWords(360_000)} · last moved ${lastMovedWords(60_000)}`).toBe("Going for 6 min · last moved 1 min ago");
  });

  it("gives a start time the way the status bar does, in the device's time zone", () => {
    const now = new Date(2026, 10, 16, 14, 5).getTime();
    expect(stepTime(new Date(2026, 10, 16, 9, 37).getTime(), now)).toBe("9:37");
    expect(stepTime(new Date(2026, 10, 16, 13, 7).getTime(), now)).toBe("1:07");
    expect(stepTime(new Date(2026, 10, 16, 0, 5).getTime(), now)).toBe("12:05");
    expect(stepTime(new Date(2026, 10, 14, 9, 37).getTime(), now)).toBe("Sat 9:37");
    expect(stepTime(new Date(2026, 10, 10, 21, 37).getTime(), now)).toBe("Tue 9:37");
    expect(stepTime(new Date(2026, 10, 9, 9, 37).getTime(), now)).toBe("Nov 9 9:37");
    expect(stepTime(new Date(2026, 10, 3, 9, 37).getTime(), now)).toBe("Nov 3 9:37");
    expect(stepTime(new Date(2025, 11, 30, 9, 37).getTime(), now)).toBe("Dec 30 9:37");
  });
});

describe("the folded sentence", () => {
  it.each([
    [{ edit: 4, command: 8 }, "Made 4 changes and tried 8 things"],
    [{ edit: 2, command: 2, check: 1 }, "Made 2 changes and tried 2 things"],
    [{ read: 3, wrote: 1 }, "Wrote 1 new thing and looked at 3 things"],
    [{ edit: 1, command: 5, search: 2, web: 1 }, "Tried 5 things and searched twice"],
    [{ read: 2, wrote: 3 }, "Wrote 3 new things and looked at 2 things"],
    [{ plan: 3 }, null],
    [{}, null],
    [{ edit: 0 }, null],
    [{ read: 2, search: 2, edit: 2 }, "Made 2 changes and looked at 2 things"],
    [{ web: 2, delete: 2 }, "Removed 2 things and searched the web twice"],
    [{ read: 1, wrote: 1 }, "Wrote 1 new thing and looked at 1 thing"],
    [{ command: 1, tool: 1 }, "Tried 1 thing"],
    [{ screen: 1, computer: 2 }, "Used the computer 3 times"],
    [{ search: 1, chats: 1, plan: 4 }, "Searched once and looked through past chats once"],
    [{ help: 1 }, "Got help once"],
    [{ team: 2, dog: 1, note: 1, phone: 1 }, "Checked in with other dogs twice and used your iPhone once"],
    [{ command: 84, tool: 24, edit: 12, web: 3 }, "Made 12 changes and tried 84 things"],
    [{ page: 3, open: 2, web: 2 }, "Visited 5 pages and searched the web twice"],
    [{ screen: 10, computer: 20 }, "Used the computer 30 times"],
    [{ tool: 24 }, "Used 24 tools"],
    [{ check: 3 }, "Checked results 3 times"],
    [{ read: 9 }, "Looked at 9 things"],
    [{ edit: 3, command: 12 }, "Made 3 changes and tried 12 things"],
  ] as Array<[Partial<Record<OutcomeKind, number>>, string | null]>)("folds %j into one sentence", (counts, sentence) => {
    expect(foldSentence(counts)).toBe(sentence);
  });

  it("never names files or commands, whatever the dog did", () => {
    const kinds: OutcomeKind[] = ["edit", "command", "check", "cloud", "read", "wrote", "search", "chats", "web", "page", "open", "screen", "computer", "team", "phone", "delete", "dog", "note", "help", "plan", "tool"];
    for (const kind of kinds) for (const count of [1, 2, 7]) expect(foldSentence({ [kind]: count }) ?? "").not.toMatch(/\b(?:files?|commands?)\b/i);
  });
});

describe("step labels", () => {
  it.each([
    [{ outcome: "edit", subject: "order form" }, "Changed the order form"],
    [{ outcome: "read", subject: "spring menu" }, "Read the spring menu"],
    [{ outcome: "wrote", subject: "spring menu" }, "Wrote the spring menu"],
    [{ outcome: "delete", subject: "old menu" }, "Removed the old menu"],
    [{ outcome: "command", subject: "Run the order form tests" }, "Ran the order form tests"],
    [{ outcome: "check", subject: "Check the build output" }, "Checked the build output"],
    [{ outcome: "cloud", subject: "Build the app" }, "Built the app"],
    [{ outcome: "command", subject: "run the tests" }, "Ran the tests"],
    [{ outcome: "command", subject: "deploy a preview" }, "Deploy a preview"],
    [{ outcome: "command", subject: "Running the tests" }, "Running the tests"],
    [{ outcome: "help", subject: "Check the spring menu" }, "Asked a puppy to check the spring menu"],
    [{ outcome: "help", subject: "API review of the order form" }, "Asked a puppy to API review of the order form"],
    [{ outcome: "team", subject: "Check the order form", helperName: "Otis" }, "Asked Otis to check the order form"],
    [{ outcome: "team", subject: "Check the order form" }, "Asked a dog"],
    [{ outcome: "search", subject: "pickup" }, "Searched for “pickup”"],
    [{ outcome: "chats", subject: "spring menu" }, "Searched for “spring menu”"],
    [{ outcome: "web", subject: "stripe.com" }, "Looked up stripe.com"],
    [{ outcome: "page", subject: "stripe.com" }, "Looked up stripe.com"],
    [{ outcome: "open", subject: "stripe.com" }, "Looked up stripe.com"],
    [{ outcome: "screen" }, "Looked at the screen"],
    [{ outcome: "computer", subject: "stripe.com" }, "Looked at the screen"],
    [{ outcome: "command" }, "Tried something"],
    [{ outcome: "edit", subject: "  " }, "Made a change"],
    [{ outcome: "read" }, "Looked through one thing"],
    [{ outcome: "web" }, "Looked something up"],
    [{ outcome: "team", helperName: "Otis" }, "Asked a dog"],
    [{ outcome: "phone" }, "Used your iPhone"],
    [{ outcome: "dog" }, "Made a new dog"],
    [{ outcome: "note" }, "Made a note"],
    [{ outcome: "help" }, "Got some help"],
    [{ outcome: "tool" }, "Did something"],
    [{ outcome: "plan" }, "Updated the plan"],
  ] as Array<[{ outcome: OutcomeKind; subject?: string; helperName?: string }, string]>)("labels %j", (step, label) => {
    expect(stepLabel({ state: "done", ...step })).toBe(label);
  });

  it("turns each listed first word to the past tense", () => {
    const words = [["Run", "Ran"], ["Check", "Checked"], ["Test", "Tested"], ["Build", "Built"], ["Install", "Installed"], ["Start", "Started"],
      ["Open", "Opened"], ["Make", "Made"], ["Add", "Added"], ["Remove", "Removed"], ["Update", "Updated"], ["Fix", "Fixed"], ["Find", "Found"],
      ["List", "Listed"], ["Show", "Showed"], ["Get", "Got"], ["Look", "Looked"], ["Create", "Created"]];
    for (const [now, past] of words) expect(stepLabel({ outcome: "command", state: "done", subject: `${now} the order form` })).toBe(`${past} the order form`);
  });

  it("words a failed step the same way", () => {
    expect(stepLabel({ outcome: "command", state: "failed", subject: "Run the tests" })).toBe("Ran the tests");
  });
});

describe("side jobs and helpers", () => {
  it("counts side jobs", () => {
    expect(sideJobsWords(1)).toBe("1 side job");
    expect(sideJobsWords(2)).toBe("2 side jobs");
    expect(sideJobsStillGoing(1)).toBe("1 side job still going");
    expect(sideJobsStillGoing(2)).toBe("2 side jobs still going");
  });

  it("puts a helper that needs an answer first", () => {
    expect(helpersLine([{ name: "Pip", state: "running" }, { name: "Otis", state: "needsYou" }])).toEqual({ text: "Otis needs your answer", needsYou: true });
    expect(helpersLine([{ name: "Otis", state: "needsYou" }, { name: "Wren", state: "needsYou" }])).toEqual({ text: "Otis and Wren need your answer", needsYou: true });
    expect(helpersLine([{ name: "Otis", state: "needsYou" }, { name: "Wren", state: "needsYou" }, { name: "Pip", state: "needsYou" }])).toEqual({ text: "Otis, Wren and Pip need your answer", needsYou: true });
  });

  it("names the helpers at work, queued ones included", () => {
    expect(helpersLine([])).toBeNull();
    expect(helpersLine([{ name: "Pip" }])).toEqual({ text: "Pip is working", needsYou: false });
    expect(helpersLine([{ name: "Pip", state: "running" }, { name: "Otis", state: "queued" }])).toEqual({ text: "Pip and Otis are working", needsYou: false });
    expect(helpersLine([{ name: "Biscuit" }, { name: "Pip" }, { name: "Otis" }])).toEqual({ text: "Biscuit, Pip and Otis are working", needsYou: false });
    expect(helpersLine([{ name: "Biscuit" }, { name: "Pip" }, { name: "Otis" }, { name: "Wren" }])).toEqual({ text: "Biscuit, Pip and 2 more are working", needsYou: false });
  });

  it("never says waiting on", () => {
    const lines = [[{ name: "Otis", state: "queued" as const }], [{ name: "Otis", state: "needsYou" as const }]].map(helpers => helpersLine(helpers)?.text ?? "");
    for (const line of lines) expect(line).not.toMatch(/waiting/i);
  });
});

describe("the live step", () => {
  const run = (extra: Partial<NativeRun> = {}): NativeRun => ({
    id: "run-1", threadId: "chat", turnId: "turn-1", provider: "claude", revision: 3, startedAt: 1_000, state: "running", observation: "live",
    actors: [], activityCount: 4, failureCount: 0, limitations: [], ...extra,
  });
  const current = (kind: NonNullable<NativeRun["currentActivity"]>["kind"], label: string, startedAt?: number): NativeRun["currentActivity"] =>
    ({ id: "claude-tool-a1", actorId: "parent", kind, label, state: "running", ...(startedAt === undefined ? {} : { startedAt }) });

  it("is nothing when no run is live", () => {
    expect(liveStep(undefined)).toBeNull();
    expect(liveStep(run({ observation: "complete", currentActivity: current("tool", "Bash", 5_000) }))).toBeNull();
    expect(liveStep(run({ observation: "partial" }))).toBeNull();
    expect(liveStep(run({ observation: "interrupted" }))).toBeNull();
  });

  it("follows the current step", () => {
    expect(liveStep(run({ lastActivityAt: 7_000, currentActivity: current("tool", "Bash", 5_000) }))).toEqual({ id: "claude-tool-a1", kind: "running", startedAt: 5_000, lastActivityAt: 7_000 });
    expect(liveStep(run({ currentActivity: current("tool", "Bash", 5_000) }))).toEqual({ id: "claude-tool-a1", kind: "running", startedAt: 5_000, lastActivityAt: 5_000 });
    expect(liveStep(run({ lastActivityAt: 7_000, currentActivity: current("tool", "Bash") }))).toEqual({ id: "claude-tool-a1", kind: "running", startedAt: 7_000, lastActivityAt: 7_000 });
    expect(liveStep(run({ currentActivity: current("tool", "Bash") }))).toEqual({ id: "claude-tool-a1", kind: "running", startedAt: 1_000, lastActivityAt: 1_000 });
  });

  it.each([
    ["reasoning", "Thinking", "thinking"],
    ["search", "WebSearch: pickup", "searching"],
    ["tool", "Read", "reading"],
    ["tool", "mcp__agents__shared_computer", "computer"],
    ["tool", "npm test", "working"],
    ["message", "Reply", "working"],
    ["request", "Approval needed", "working"],
    ["notice", "Retrying", "working"],
  ] as Array<[NonNullable<NativeRun["currentActivity"]>["kind"], string, ActivityKind]>)("reads a %s step labelled %s as %s", (kind, label, expected) => {
    expect(liveStep(run({ currentActivity: current(kind, label, 5_000) }))?.kind).toBe(expected);
  });

  it("thinks between steps under one id until a new step arrives", () => {
    const between = liveStep(run({ lastActivityAt: 7_000 }));
    expect(between).toEqual({ id: "run-1:thinking:4", kind: "thinking", startedAt: 7_000, lastActivityAt: 7_000 });
    expect(liveStep(run({ lastActivityAt: 7_000, revision: 9 }))?.id).toBe(between!.id);
    expect(liveStep(run({ lastActivityAt: 9_000, activityCount: 5 }))?.id).toBe("run-1:thinking:5");
    expect(liveStep(run())).toEqual({ id: "run-1:thinking:4", kind: "thinking", startedAt: 1_000, lastActivityAt: 1_000 });
  });
});
