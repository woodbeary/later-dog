import { describe, expect, it } from "vitest";
import { SavingNoticeOnce, savingNotice } from "./saving-notice.ts";

const coded = (code: string) => Object.assign(new Error(code), { code });

describe("saving notice", () => {
  it("says the computer is almost out of space, naming the right kind of computer, and what to do", () => {
    expect(savingNotice(coded("ENOSPC"), "darwin")).toBe("Your Mac is almost out of space, so later.dog couldn't save part of this chat. Free up some space and it will keep saving.");
    expect(savingNotice(coded("EDQUOT"), "win32")).toMatch(/^Your PC is almost out of space/);
    expect(savingNotice(coded("ENOSPC"), "linux")).toMatch(/^This computer is almost out of space/);
  });
  it("names a permission problem and any other problem without blaming the disk", () => {
    for (const code of ["EACCES", "EPERM", "EROFS"]) expect(savingNotice(coded(code))).toMatch(/isn't allowed to write to its data folder/);
    expect(savingNotice(new Error("weird"))).toBe("later.dog couldn't save part of this chat. It will keep trying.");
    expect(savingNotice(undefined)).toBe("later.dog couldn't save part of this chat. It will keep trying.");
  });
  it("never uses the old technical words, or says user", () => {
    for (const error of [coded("ENOSPC"), coded("EACCES"), new Error("x")]) {
      expect(savingNotice(error)).not.toMatch(/canonical|event history|\buser\b/i);
    }
  });
  it("gives each chat one notice per session", () => {
    const once = new SavingNoticeOnce();
    expect(once.next("a", coded("ENOSPC"), "darwin")).toMatch(/almost out of space/);
    expect(once.next("a", coded("ENOSPC"), "darwin")).toBeUndefined();
    expect(once.next("b", coded("ENOSPC"), "darwin")).toMatch(/almost out of space/);
    expect(once.next("a", new Error("later"))).toBeUndefined();
  });
});
