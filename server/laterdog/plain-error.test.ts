import { describe, expect, it } from "vitest";
import { plainFailure, tooBigMessage } from "./plain-error.ts";

const coded = (code: string, message: string, status?: number) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) });

describe("plain failures", () => {
  it("says a full disk in words, naming the kind of computer, whichever layer noticed it", () => {
    const file = coded("ENOSPC", "ENOSPC: no space left on device, open '/Users/x/.laterdog/bots.json.1.tmp'");
    expect(plainFailure(file, "darwin")).toEqual({
      status: 500,
      internal: true,
      message: "Your Mac is almost out of space, so later.dog couldn't save that. Free up some space and try again.",
    });
    const database = Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" });
    expect(plainFailure(database, "win32").message).toMatch(/^Your PC is almost out of space/);
    expect(plainFailure(new Error("write failed: no space left on device"), "linux").message).toMatch(/^This computer is almost out of space/);
  });

  it("keeps the real status and never shows the path, code or stack", () => {
    for (const error of [
      coded("ENOENT", "ENOENT: no such file or directory, open '/Users/jacob/.laterdog/x'"),
      coded("EBUSY", "EBUSY: resource busy or locked, rename '/tmp/a' -> '/tmp/b'"),
      new Error("cannot rollback - no transaction is active"),
      new Error("database is locked"),
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      new Error("boom\n    at handle (/Users/jacob/code/dog/server/index.ts:12:3)"),
    ]) {
      const result = plainFailure(error);
      expect(result.status).toBe(500);
      expect(result.internal).toBe(true);
      expect(result.message).toBe("Something went wrong on this computer, so that didn't go through. Try again, and if it keeps happening, quit and reopen later.dog.");
    }
  });

  it("names a data folder it cannot write to", () => {
    for (const code of ["EACCES", "EPERM", "EROFS"]) {
      expect(plainFailure(coded(code, `${code}: denied, open '/x'`)).message).toMatch(/isn't allowed to write to its data folder/);
    }
  });

  it("leaves a deliberate message and its status alone", () => {
    expect(plainFailure(Object.assign(new Error("the linked file is unavailable"), { status: 404 }))).toEqual({ status: 404, internal: false, message: "the linked file is unavailable" });
    expect(plainFailure(new Error("Invalid hosted Claude models."))).toEqual({ status: 500, internal: false, message: "Invalid hosted Claude models." });
    expect(plainFailure("plain text")).toEqual({ status: 500, internal: false, message: "plain text" });
  });

  it("turns a byte limit into megabytes", () => {
    const file = Object.assign(new Error("file exceeds 26214400 bytes"), { status: 413 });
    expect(plainFailure(file)).toEqual({ status: 413, internal: false, message: "That file is bigger than 25 MB, which is the most later.dog takes. Try a smaller one." });
    expect(plainFailure(Object.assign(new Error("image exceeds 10485760 bytes"), { status: 413 })).message).toMatch(/^That picture is bigger than 10 MB/);
  });

  it("states a limit once, the same way, wherever it is checked", () => {
    expect(tooBigMessage("file", 25 * 1024 * 1024)).toBe("That file is bigger than 25 MB, which is the most later.dog takes. Try a smaller one.");
    expect(tooBigMessage("image", 10 * 1024 * 1024)).toMatch(/^That picture is bigger than 10 MB/);
    expect(tooBigMessage("audio", 1.5 * 1024 * 1024)).toMatch(/bigger than 1\.5 MB/);
  });

  it("never says the user", () => {
    for (const error of [coded("ENOSPC", "x"), coded("EACCES", "x"), new TypeError("x")]) {
      expect(plainFailure(error).message).not.toMatch(/\bthe user\b|errno|sqlite|stack/i);
    }
  });
});
