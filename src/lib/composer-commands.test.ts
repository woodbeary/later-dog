import { describe, expect, it } from "vitest";
import {
  cleanCommandName,
  composerSlashTrigger,
  replaceComposerSlashTrigger,
  slashChoices,
  suggestedCommandName,
  typedAction,
  type DogCommand,
} from "./composer-commands";

describe("composer slash commands", () => {
  it("opens command search only for the first unfinished token", () => {
    expect(composerSlashTrigger("/", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(composerSlashTrigger("/le", 3)).toEqual({ query: "le", start: 0, end: 3 });
    expect(composerSlashTrigger("hello /le", 9)).toBeNull();
    expect(composerSlashTrigger("/learn write", 12)).toBeNull();
  });

  it("replaces the active token without losing text after the caret", () => {
    expect(
      replaceComposerSlashTrigger("/go later", { query: "go", start: 0, end: 3 }, ""),
    ).toEqual({ text: " later", caret: 0 });
    expect(
      replaceComposerSlashTrigger("/le", { query: "le", start: 0, end: 3 }, "/learn "),
    ).toEqual({ text: "/learn ", caret: 7 });
  });
});

const commands: DogCommand[] = [
  { name: "plan", line: "Write a plan first", kind: "mine", text: "Write a plan first" },
  { name: "deploy-site", line: "Ship the site", kind: "trick" },
  { name: "review", line: "Look over the work for real faults", kind: "standard", text: "Review." },
  { name: "compact", line: "Summarize this chat so far", kind: "action" },
];

describe("the / list for a dog", () => {
  it("opens on digits too", () => {
    expect(composerSlashTrigger("/c2", 3)).toEqual({ query: "c2", start: 0, end: 3 });
  });

  it("narrows as the person types, names that start with the words first, and ends with New command", () => {
    expect(slashChoices(commands, "", true).map((choice) => choice.key)).toEqual(["mine:plan", "trick:deploy-site", "standard:review", "action:compact", "new"]);
    expect(slashChoices(commands, "RE", true).map((choice) => choice.key)).toEqual(["standard:review", "new"]);
    expect(slashChoices(commands, "s", false).map((choice) => choice.key)).toEqual(["trick:deploy-site", "action:compact"]);
    expect(slashChoices(commands, "faults", false).map((choice) => choice.key)).toEqual(["standard:review"]);
    expect(slashChoices(commands, "ar", false).map((choice) => choice.key)).toEqual([]);
    expect(slashChoices(commands, "zzz", true)).toEqual([]);
    expect(slashChoices([], "", true).map((choice) => choice.key)).toEqual(["new"]);
  });

  it("runs an action typed on its own and nothing else", () => {
    expect(typedAction(" /Compact ", commands)?.name).toBe("compact");
    expect(typedAction("/compact now", commands)).toBeNull();
    expect(typedAction("/review", commands)).toBeNull();
  });

  it("suggests a short name from a message and cleans a typed one", () => {
    expect(suggestedCommandName("Split the work: you plan, helpers build!")).toBe("split-the-work");
    expect(suggestedCommandName("…")).toBe("");
    expect(cleanCommandName(" /Plan-It ")).toBe("plan-it");
  });
});
