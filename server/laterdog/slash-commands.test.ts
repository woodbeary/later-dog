import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CommandRefused,
  commandSend,
  COMMANDS_FILE,
  dogCommands,
  expandCommand,
  MAX_SAVED_COMMANDS,
  SavedCommands,
  STANDARD_COMMANDS,
  tricksInIndex,
} from "./slash-commands.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "slash-commands-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof CommandRefused) return { status: error.status, message: error.message };
    throw error;
  }
  return null;
};

describe("the person's saved commands", () => {
  it("keeps a command on the home under a clean name, renames it and deletes it", () => {
    const dir = scratch();
    let clock = 1_000;
    const store = new SavedCommands(dir, () => clock);
    expect(store.list()).toEqual([]);
    expect(store.create(" /Ship-It ", "  Open a draft pull request.  ")).toEqual({ name: "ship-it", text: "Open a draft pull request.", updatedAt: 1_000 });
    clock = 2_000;
    expect(store.update("ship-it", { name: "ship" })).toEqual({ name: "ship", text: "Open a draft pull request.", updatedAt: 2_000 });
    expect(new SavedCommands(dir).list().map((command) => command.name)).toEqual(["ship"]);
    expect(statSync(join(dir, COMMANDS_FILE)).mode & 0o777).toBe(0o600);
    store.remove("ship");
    expect(store.list()).toEqual([]);
  });

  it("refuses names that clash, bad names, later.dog's own actions and empty text", () => {
    const store = new SavedCommands(scratch());
    store.create("plan", "Plan first.");
    expect(refusal(() => store.create("plan", "Again."))).toEqual({ status: 409, message: "You already have /plan." });
    expect(refusal(() => store.create("two words", "x"))?.status).toBe(400);
    expect(refusal(() => store.create("compact", "x"))).toEqual({ status: 409, message: "/compact is already a later.dog command. Pick another name." });
    expect(refusal(() => store.create("empty", "   "))?.status).toBe(400);
    store.create("other", "Other.");
    expect(refusal(() => store.update("other", { name: "plan" }))?.status).toBe(409);
    expect(refusal(() => store.update("missing", { text: "x" }))?.status).toBe(404);
    expect(refusal(() => store.remove("missing"))?.status).toBe(404);
  });

  it("stops at the limit", () => {
    const store = new SavedCommands(scratch());
    for (let index = 0; index < MAX_SAVED_COMMANDS; index += 1) store.create(`c${index}`, "x");
    expect(refusal(() => store.create("one-more", "x"))?.status).toBe(409);
  });

  it("changes nothing when the saved file cannot be read", () => {
    const dir = scratch();
    writeFileSync(join(dir, COMMANDS_FILE), "{ not json");
    const store = new SavedCommands(dir);
    expect(store.list()).toEqual([]);
    expect(refusal(() => store.create("plan", "x"))?.status).toBe(500);
    expect(readFileSync(join(dir, COMMANDS_FILE), "utf8")).toBe("{ not json");
  });
});

describe("what a dog can be told with one word", () => {
  const saved = [{ name: "review", text: "My own review steps.\nSecond line.", updatedAt: 1 }];
  const tricks = [{ name: "Deploy-Site", description: "Ship the site to production." }, { name: "debug", description: "The dog's own debugging." }, { name: "learn", description: "x" }];

  it("lists my commands first, then the dog's tricks, then the standard set and compact, each name once", () => {
    const list = dogCommands(saved, tricks);
    expect(list.slice(0, 3)).toEqual([
      { name: "review", line: "My own review steps.", kind: "mine", text: "My own review steps.\nSecond line." },
      { name: "deploy-site", line: "Ship the site to production.", kind: "trick" },
      { name: "debug", line: "The dog's own debugging.", kind: "trick" },
    ]);
    expect(list.filter((command) => command.kind === "standard").map((command) => command.name))
      .toEqual(STANDARD_COMMANDS.map((command) => command.name).filter((name) => name !== "review" && name !== "debug"));
    expect(list.at(-1)).toEqual({ name: "compact", line: "Summarize this chat so far to free up room", kind: "action" });
    expect(list.some((command) => command.name === "learn")).toBe(false);
    expect(new Set(list.map((command) => command.name)).size).toBe(list.length);
  });

  it("turns /name and more words into the saved text with the words after it", () => {
    const list = dogCommands(saved, tricks);
    expect(expandCommand("/review   the login change", list)).toEqual({ name: "review", text: "My own review steps.\nSecond line.\n\nthe login change" });
    expect(expandCommand("/Deploy-Site\nto staging", list)).toEqual({ name: "deploy-site", text: "Use your trick \"deploy-site\" for this.\n\nto staging" });
    expect(expandCommand("/status", list)?.text).toBe(STANDARD_COMMANDS.find((command) => command.name === "status")!.text);
  });

  it("leaves everything else as typed", () => {
    const list = dogCommands(saved, tricks);
    expect(expandCommand("/compact", list)).toBeNull();
    expect(expandCommand("/etc/hosts is broken", list)).toBeNull();
    expect(expandCommand("/reviewer please", list)).toBeNull();
    expect(expandCommand("please /review", list)).toBeNull();
    expect(expandCommand("/nothing-here", list)).toBeNull();
  });
});

describe("who a /name is expanded for", () => {
  const list = () => dogCommands([{ name: "plan", text: "Plan first.", updatedAt: 1 }], []);

  it("expands the owner's own sends and says so", () => {
    expect(commandSend("/plan the page", { scopes: ["admin", "client"], fromLocalTools: false }, list)).toEqual({ text: "Plan first.\n\nthe page", expanded: true });
    expect(commandSend("plan the page", { scopes: ["admin"], fromLocalTools: false }, list)).toEqual({ text: "plan the page", expanded: false });
  });

  it("leaves a guest's, a shared client's and a dog's sends as typed, without reading the saved commands", () => {
    const never = () => { throw new Error("read the saved commands"); };
    expect(commandSend("/plan", { scopes: ["client"], fromLocalTools: false }, never)).toEqual({ text: "/plan", expanded: false });
    expect(commandSend("/plan", { scopes: ["admin", "client"], fromLocalTools: true }, never)).toEqual({ text: "/plan", expanded: false });
  });
});

describe("which tricks a dog can be told by name", () => {
  it("keeps only the tricks its instructions carry", () => {
    const index = "\n\nImported skills:\n- deploy-site: Ship it. Read \"/w/deploy-site/SKILL.md\".\n- notes: Keep notes. Read \"/w/notes/SKILL.md\".\n2 enabled skills omitted";
    const tricks = [{ name: "deploy-site", description: "Ship it." }, { name: "notes", description: "Keep notes." }, { name: "dropped", description: "Past the cap." }];
    expect(tricksInIndex(tricks, index).map((trick) => trick.name)).toEqual(["deploy-site", "notes"]);
    expect(tricksInIndex(tricks, "")).toEqual([]);
  });
});
