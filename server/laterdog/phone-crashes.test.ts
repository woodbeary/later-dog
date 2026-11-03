import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { phoneCrashLine, phoneCrashReport, PhoneCrashes } from "./phone-crashes.ts";

describe("phone crash reports on the home", () => {
  it("says in one line how the app went down, on which build and update", () => {
    expect(phoneCrashLine({ kind: "ended", at: 13_000, startedAt: 1_000, build: "9", update: "01a19f3a-1df3" }))
      .toBe("phone crash report: the app ended without closing after 12 s (build 9, update 01a19f3a)");
    expect(phoneCrashLine({ kind: "ended", at: 13_000, message: "TypeError: x is undefined" }))
      .toBe("phone crash report: the app ended without closing; its last error: TypeError: x is undefined");
    expect(phoneCrashLine({ kind: "error", at: 1, fatal: true, build: "9", message: "boom" })).toBe("phone crash report: fatal error (build 9): boom");
  });

  it("takes only the fields a report carries", () => {
    expect(phoneCrashReport.safeParse({ kind: "ended", at: 5 }).success).toBe(true);
    expect(phoneCrashReport.safeParse({ kind: "ended", at: 5, token: "x" }).success).toBe(false);
    expect(phoneCrashReport.safeParse({ kind: "exploded", at: 5 }).success).toBe(false);
    expect(phoneCrashReport.safeParse({ kind: "error", at: 5, stack: "s".repeat(9_000) }).success).toBe(false);
  });

  it("keeps the newest reports in a file a dog can read", () => {
    const file = join(mkdtempSync(join(tmpdir(), "phone-crashes-")), "phone-crashes.json");
    const crashes = new PhoneCrashes(file, 2);
    crashes.record({ kind: "ended", at: 1 }, 10);
    crashes.record({ kind: "error", at: 2, message: "two" }, 20);
    crashes.record({ kind: "error", at: 3, message: "three" }, 30);
    expect(crashes.recent().map((report) => report.at)).toEqual([2, 3]);
    expect(JSON.parse(readFileSync(file, "utf8"))[1]).toMatchObject({ message: "three", receivedAt: 30 });
    expect(new PhoneCrashes(join(file, "..", "missing.json")).recent()).toEqual([]);
  });
});
