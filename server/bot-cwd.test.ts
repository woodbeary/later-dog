import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { validateBotCwd } from "./bot-cwd.ts";

const dir = mkdtempSync(join(tmpdir(), "laterdog-cwd-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("validateBotCwd", () => {
  it("accepts an existing absolute directory", () => {
    expect(validateBotCwd(dir)).toEqual({ ok: true, cwd: dir });
  });

  it("treats null and empty as clearing the folder", () => {
    expect(validateBotCwd(null)).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("")).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("   ")).toEqual({ ok: true, cwd: null });
  });

  it("expands a leading ~ to the home folder", () => {
    expect(validateBotCwd("~")).toEqual({ ok: true, cwd: resolve(homedir()) });
  });

  it("rejects relative paths, files, and missing folders with a reason", () => {
    expect(validateBotCwd("relative/path")).toEqual({
      ok: false,
      error: expect.stringMatching(/absolute/),
    });
    const file = join(dir, "a-file.txt");
    writeFileSync(file, "x");
    expect(validateBotCwd(file)).toEqual({
      ok: false,
      error: expect.stringMatching(/not a folder/),
    });
    expect(validateBotCwd(join(dir, "nope"))).toEqual({
      ok: false,
      error: expect.stringMatching(/doesn't exist/),
    });
    expect(validateBotCwd(42)).toEqual({ ok: false, error: expect.stringMatching(/path/) });
  });
});

describe("a helper's authorized working folder", () => {
  const root = join(dir, "creator");
  const inside = join(root, "inside");
  const elsewhere = join(dir, "creator-other");
  mkdirSync(inside, { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(root, "escape"), "dir");
  symlinkSync(inside, join(root, "alias"), "dir");
  symlinkSync(root, join(dir, "root-alias"), "dir");

  it.each([elsewhere, join(root, ".."), join(root, "escape")])(
    "refuses an existing folder outside the creator's canonical root: %s",
    (folder) => {
      expect(validateBotCwd(folder, [root])).toMatchObject({
        ok: false,
        error: expect.stringMatching(/creating chat/),
      });
    },
  );

  it("returns the canonical child path and handles a symlinked authorized root", () => {
    expect(validateBotCwd(join(root, "alias"), [root])).toEqual({
      ok: true,
      cwd: realpathSync(inside),
    });
    expect(validateBotCwd(inside, [join(dir, "root-alias")])).toEqual({
      ok: true,
      cwd: realpathSync(inside),
    });
    expect(validateBotCwd(root, [root])).toEqual({ ok: true, cwd: realpathSync(root) });
  });

  it("keeps default folders private and existing owner-authorized literal paths unchanged", () => {
    expect(validateBotCwd(null, [root])).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("", [root])).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd(join(root, "escape"))).toEqual({
      ok: true,
      cwd: resolve(root, "escape"),
    });
  });

  it("fails closed when the creator's root is missing", () => {
    expect(validateBotCwd(inside, [join(dir, "missing-root")])).toMatchObject({ ok: false });
  });
});
