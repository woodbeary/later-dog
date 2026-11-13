import { describe, expect, it } from "vitest";
import { terminalTurnPatch, turnResults } from "./turn-results.ts";
import { claudeToolTouch, codexToolTouch, writtenChange } from "./tool-touches.ts";
import { pullRequestLink, TurnTouches } from "./turn-touches.ts";

const PR = "https://github.com/example/repo/pull/7";

describe("what a finished turn left behind", () => {
  it.each([
    ["no facts", {}],
    ["empty lists and zero commands", { files: [], links: [], commands: 0 }],
  ])("is absent with %s", (_name, facts) => {
    expect(turnResults(facts)).toBeUndefined();
  });

  it("lists each file once with its final change", () => {
    expect(turnResults({ files: [
      { path: "/w/a.ts", change: "edited" },
      { path: "/w/a.ts", change: "edited" },
      { path: "/w/b.ts", change: "created" },
      { path: "/w/b.ts", change: "edited" },
      { path: "/w/c.ts", change: "edited" },
      { path: "/w/c.ts", change: "deleted" },
    ], cwd: "/w" })).toEqual({ files: [
      { path: "a.ts", change: "edited" },
      { path: "b.ts", change: "created" },
      { path: "c.ts", change: "deleted" },
    ] });
  });

  it("drops a file created and deleted in the same turn", () => {
    expect(turnResults({ files: [{ path: "/w/tmp.txt", change: "created" }, { path: "/w/tmp.txt", change: "deleted" }], cwd: "/w" })).toBeUndefined();
  });

  it("calls a file deleted and written again edited", () => {
    expect(turnResults({ files: [{ path: "/w/x", change: "deleted" }, { path: "/w/x", change: "created" }], cwd: "/w" })?.files)
      .toEqual([{ path: "x", change: "edited" }]);
  });

  it("caps the list and counts the rest", () => {
    const files = Array.from({ length: 23 }, (_, i) => ({ path: `/w/f${i}.ts`, change: "edited" as const }));
    const results = turnResults({ files, cwd: "/w/" });
    expect(results?.files).toHaveLength(20);
    expect(results?.files?.[19]).toEqual({ path: "f19.ts", change: "edited" });
    expect(results?.moreFiles).toBe(3);
  });

  it("shows paths relative to the working folder and never with the home folder", () => {
    expect(turnResults({ files: [
      { path: "/Users/pat/code/app/src/a.ts", change: "edited" },
      { path: "/Users/pat/notes.md", change: "created" },
      { path: "/Users/pat/code/application/b.ts", change: "edited" },
      { path: "/tmp/out.log", change: "created" },
    ], cwd: "/Users/pat/code/app", home: "/Users/pat" })?.files).toEqual([
      { path: "src/a.ts", change: "edited" },
      { path: "~/notes.md", change: "created" },
      { path: "~/code/application/b.ts", change: "edited" },
      { path: "/tmp/out.log", change: "created" },
    ]);
  });

  it("keeps a pull request link from a cloud task once, and the command count", () => {
    const link = { kind: "pull-request" as const, label: "Fix login", url: PR };
    expect(turnResults({ links: [link, link], commands: 4 })).toEqual({ links: [link], commands: 4 });
  });

  it("refuses links that are not web addresses", () => {
    expect(turnResults({ links: [{ kind: "page", label: "x", url: "javascript:alert(1)" }] })).toBeUndefined();
  });
});

describe("recording what tools touched", () => {
  it("reads paths from file tools and counts shell commands", () => {
    expect(claudeToolTouch("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" })).toEqual({ files: [{ path: "/w/a.ts", change: "edited" }] });
    expect(claudeToolTouch("Write", { file_path: "/w/n.ts", content: "secret body" })).toEqual({ files: [{ path: "/w/n.ts", change: "written" }] });
    expect(claudeToolTouch("NotebookEdit", { notebook_path: "/w/n.ipynb" })).toEqual({ files: [{ path: "/w/n.ipynb", change: "edited" }] });
    expect(claudeToolTouch("Bash", { command: "ls" })).toEqual({ command: true });
    expect(claudeToolTouch("Read", { file_path: "/w/a.ts" })).toBeUndefined();
    expect(codexToolTouch({ type: "commandExecution", command: "ls" })).toEqual({ command: true });
    expect(codexToolTouch({ type: "fileChange", changes: [
      { path: "/w/new.ts", kind: { type: "add" }, diff: "+x" },
      { path: "/w/old.ts", kind: { type: "delete" }, diff: "" },
      { path: "/w/a.ts", kind: { type: "update", move_path: null }, diff: "" },
      { path: "/w/from.ts", kind: { type: "update", move_path: "/w/to.ts" }, diff: "" },
    ] })).toEqual({ files: [
      { path: "/w/new.ts", change: "created" },
      { path: "/w/old.ts", change: "deleted" },
      { path: "/w/a.ts", change: "edited" },
      { path: "/w/from.ts", change: "deleted" },
      { path: "/w/to.ts", change: "created" },
    ] });
  });

  it("tells a new file from an overwritten one by the tool's own result", () => {
    expect(writtenChange("File created successfully at: /w/n.ts")).toBe("created");
    expect(writtenChange("[\n  {\n    \"type\": \"text\",\n    \"text\": \"File created successfully at: /w/n.ts\"\n  }\n]")).toBe("created");
    expect(writtenChange("The file /w/n.ts has been updated.")).toBe("edited");
  });

  it("keeps only finished calls, ignores free reply text, and takes the pull request from a cloud job result", () => {
    const touches = new TurnTouches();
    touches.begin("t");
    touches.start("t", "1", { files: [{ path: "/w/a.ts", change: "edited" }] });
    touches.start("t", "2", { files: [{ path: "/w/b.ts", change: "edited" }] });
    touches.start("t", "3", { command: true });
    touches.finish("t", "1", { ok: true });
    touches.finish("t", "2", { ok: false });
    touches.finish("t", "3", { ok: false, output: `see ${PR}` });
    touches.finish("t", "4", { ok: true, toolName: "mcp__laterdog__publish_cloud_job", output: JSON.stringify({ id: "0b6a4a52-6f1f-4b8e-9d55-3f7f8f0e1a2b", title: "Fix login", prUrl: PR }) });
    touches.finish("t", "5", { ok: true, toolName: "web_search", output: JSON.stringify({ id: "0b6a4a52-6f1f-4b8e-9d55-3f7f8f0e1a2c", title: "x", prUrl: PR }) });
    expect(touches.observed("t")).toEqual({
      files: [{ path: "/w/a.ts", change: "edited" }],
      commands: 1,
      links: [{ kind: "pull-request", label: "Fix login", url: PR }],
    });
    touches.begin("t");
    expect(touches.observed("t")).toBeUndefined();
  });

  it("takes a pull request only from tools that open or publish it in this turn, never from one that looks up or reviews an older job", () => {
    const job = (title: string) => JSON.stringify({ id: "0b6a4a52-6f1f-4b8e-9d55-3f7f8f0e1a2b", title, prUrl: PR });
    for (const tool of ["inspect_cloud_job", "review_cloud_job", "correct_cloud_job", "verify_cloud_job", "merge_cloud_job"]) {
      expect(pullRequestLink(`mcp__laterdog__${tool}`, job("Old job from last week"))).toBeUndefined();
      const touches = new TurnTouches();
      touches.begin("t");
      touches.finish("t", "1", { ok: true, toolName: `mcp__laterdog__${tool}`, output: job("Old job from last week") });
      expect(touches.observed("t")).toBeUndefined();
    }
    for (const tool of ["delegate_cloud_job", "publish_cloud_job"]) {
      expect(pullRequestLink(`mcp__laterdog__${tool}`, job("Fix login"))).toEqual({ kind: "pull-request", label: "Fix login", url: PR });
      expect(pullRequestLink(`laterdog.${tool}`, job("Fix login"))?.url).toBe(PR);
    }
  });
});

describe("the turn's final message", () => {
  it("leaves a legacy message without results as it was", () => {
    const legacy = { id: "m1", role: "bot" as const, kind: "text" as const, text: "done", at: 1, turnSucceeded: true };
    const patched = { ...legacy, ...terminalTurnPatch(true, undefined, turnResults({})) };
    expect(patched).toEqual(legacy);
    expect(Object.keys(patched)).not.toContain("results");
  });

  it("carries the results beside what ran", () => {
    const results = { commands: 2 };
    expect(terminalTurnPatch(false, { model: "m" }, results)).toEqual({ turnSucceeded: false, ran: { model: "m" }, results });
  });
});
