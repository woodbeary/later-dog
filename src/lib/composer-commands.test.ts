import { describe, expect, it } from "vitest";
import {
  composerSlashTrigger,
  replaceComposerSlashTrigger,
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
