import { describe, expect, it } from "vitest";
import { en } from "@/locales";
import { helpingWords, lastMovedLine, PANEL_WORDS, panelTitle, startedWords, stepDetail, stopQuestion } from "./work-panel-model";

const words = en as Record<string, string>;

describe("the work panel's words", () => {
  it("are every one in en.json, so they can be translated", () => {
    for (const [key, value] of Object.entries(PANEL_WORDS)) expect(words[`workPanel.${key}`]).toBe(value);
  });

  it("put names and times into en.json's sentences", () => {
    expect(helpingWords("Otis")).toBe(words["workPanel.helping"].replace("{name}", "Otis"));
    expect(stopQuestion("Otis")).toBe(words["workPanel.stopQuestion"].replace("{name}", "Otis"));
    expect(startedWords(0, 60_000)).toMatch(new RegExp(`^${words["workPanel.started"].replace("{time}", "")}`));
    expect(lastMovedLine(60_000)).toMatch(new RegExp(`^${words["workPanel.lastMoved"].replace("{time}", "")}`));
    expect(panelTitle({ kind: "work", threadId: "t" }, "Juniper")).toBe(words["workPanel.titleDoing"].replace("{name}", "Juniper"));
    expect(panelTitle({ kind: "work", threadId: "t", runId: "r" }, "Juniper")).toBe(words["workPanel.titleDid"].replace("{name}", "Juniper"));
  });

  it("label what a step took in and gave back from en.json", () => {
    const detail = stepDetail({ id: "a", label: "Bash", state: "done", input: "ls", output: "ok" } as never);
    expect(detail.inputLabel).toBe(words["workPanel.input.ran"]);
    expect(detail.outputLabel).toBe(words["workPanel.cameBack"]);
  });
});
