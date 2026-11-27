import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseMachineSize, codeProjectSignals, commandCause, MachineSizeBook, stopCause } from "./machine-size.ts";

const made: string[] = [];
function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-machine-size-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which machine a task gets", () => {
  it("reads a code project from a lockfile, a package manifest, a git origin or a linked project", () => {
    expect(codeProjectSignals(folder({ "pnpm-lock.yaml": "", "package.json": "{}" }))).toEqual(["lockfile pnpm-lock.yaml", "package manifest package.json"]);
    expect(codeProjectSignals(folder({ "Cargo.toml": "" }))).toEqual(["package manifest Cargo.toml"]);
    expect(codeProjectSignals(folder({ ".git/config": '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/someone/app\n' }))).toEqual(["git origin"]);
    expect(codeProjectSignals(folder({ ".git/config": "[core]\n\tbare = false\n" }))).toEqual([]);
    expect(codeProjectSignals(folder({ "App.xcodeproj/project.pbxproj": "" }))).toEqual(["package manifest App.xcodeproj"]);
    expect(codeProjectSignals(folder({ "notes.md": "", "trip.pdf": "" }))).toEqual([]);
    expect(codeProjectSignals(undefined, true)).toEqual(["linked project"]);
    expect(codeProjectSignals(join(tmpdir(), "laterdog-no-such-folder"))).toEqual([]);
  });

  it("gives code projects a large machine and everything else a small one", () => {
    expect(chooseMachineSize({ signals: ["lockfile pnpm-lock.yaml"] })).toEqual({ size: "large", reason: "code project", signals: ["lockfile pnpm-lock.yaml"] });
    expect(chooseMachineSize({ signals: [] })).toEqual({ size: "small", reason: "default" });
  });

  it("lets the task's own choice beat the dog's, and the dog's beat the folder", () => {
    expect(chooseMachineSize({ task: "small", dog: "large", signals: ["git origin"] })).toEqual({ size: "small", reason: "task" });
    expect(chooseMachineSize({ dog: "small", signals: ["git origin"] })).toEqual({ size: "small", reason: "dog" });
    expect(chooseMachineSize({ dog: "large", signals: [] })).toEqual({ size: "large", reason: "dog" });
  });

  it("keeps an upgraded conversation large for good, whatever was asked", () => {
    expect(chooseMachineSize({ task: "small", dog: "small", upgraded: "out of memory", signals: [] })).toEqual({ size: "large", reason: "upgraded", upgradedBecause: "out of memory" });
  });

  it("upgrades after a heavy command on a small machine, and only on a small one", () => {
    expect(commandCause("cd app && pnpm install", "small")).toEqual({ kind: "heavy command", detail: "a package install" });
    expect(commandCause("pnpm test", "small")).toEqual({ kind: "heavy command", detail: "a build or test suite" });
    expect(commandCause("pnpm test", "large")).toBeNull();
    expect(commandCause("ls -la", "small")).toBeNull();
    expect(commandCause("pnpm --version", "small")).toBeNull();
  });

  it("upgrades after an out-of-memory or disk-full stop, not after an ordinary failure", () => {
    expect(stopCause({ exitCode: 137 })).toEqual({ kind: "out of memory" });
    expect(stopCause({ signal: "SIGKILL" })).toEqual({ kind: "out of memory" });
    expect(stopCause({ exitCode: 134, output: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" })).toEqual({ kind: "out of memory" });
    expect(stopCause({ exitCode: 1, output: "write /tmp/x: no space left on device" })).toEqual({ kind: "disk full" });
    expect(stopCause({ exitCode: 1, output: "npm ERR! code ENOSPC" })).toEqual({ kind: "disk full" });
    expect(stopCause({ exitCode: 1, output: "Error: tests failed" })).toBeNull();
    expect(stopCause({ exitCode: 0 })).toBeNull();
  });
});

describe("the machine size book", () => {
  it("remembers a task's size, a dog's size and an upgrade across restarts", () => {
    const dir = folder();
    const file = join(dir, "machine-sizes.json");
    const code = folder({ "package-lock.json": "{}" });
    const book = new MachineSizeBook(file, () => 5);
    expect(book.choose("olive", "t1", code)).toMatchObject({ size: "large", reason: "code project" });
    expect(book.choose("olive", "t1", dir)).toEqual({ size: "small", reason: "default" });
    book.setTaskSize("olive", "t1", "small");
    expect(book.choose("olive", "t1", code)).toEqual({ size: "small", reason: "task" });
    book.setDogSize("olive", "large");
    expect(book.choose("olive", "t2", dir)).toEqual({ size: "large", reason: "dog" });
    expect(book.noteCommand("olive", "t1", "pnpm build", "small")).toBe(true);
    expect(book.noteCommand("olive", "t1", "pnpm build", "small")).toBe(false);

    const again = new MachineSizeBook(file);
    expect(again.choose("olive", "t1", dir)).toEqual({ size: "large", reason: "upgraded", upgradedBecause: "a build or test suite" });
    expect(again.dogSize("olive")).toBe("large");
    again.setDogSize("olive", null);
    expect(again.noteStop("olive", "t3", { exitCode: 137 })).toBe(true);
    expect(new MachineSizeBook(file).choose("olive", "t3", dir)).toEqual({ size: "large", reason: "upgraded", upgradedBecause: "out of memory" });
    again.forget("olive", "t1");
    expect(new MachineSizeBook(file).choose("olive", "t1", dir)).toEqual({ size: "small", reason: "default" });
  });

  it("starts empty from a missing or broken file and drops unknown sizes", () => {
    const dir = folder({ "broken.json": "{", "odd.json": JSON.stringify({ version: 1, dogs: { a: "huge", b: "small" }, threads: {} }) });
    expect(new MachineSizeBook(join(dir, "none.json")).choose("a", "t", dir).size).toBe("small");
    expect(new MachineSizeBook(join(dir, "broken.json")).dogSize("a")).toBeUndefined();
    const odd = new MachineSizeBook(join(dir, "odd.json"));
    expect(odd.dogSize("a")).toBeUndefined();
    expect(odd.dogSize("b")).toBe("small");
  });
});
