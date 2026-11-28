import { describe, expect, it } from "vitest";
import { inventoryRow, packScript, readPacked, retirementCheck } from "../src/box-migrate";
import { boxRequest } from "../src/box-routes";

const DAY = 24 * 60 * 60_000;

describe("moving a dog's browser profile to the box", () => {
  it("counts the days left on a computer's snapshot", () => {
    const now = Date.parse("2026-11-27T00:00:00Z");
    const row = inventoryRow({ id: "cmp_1", name: "Drawer", size: "standard", state: "sleeping", createdAt: "2026-10-01T00:00:00Z", lastActiveAt: "2026-11-01T00:00:00Z", snapshotAt: new Date(now - 26 * DAY).toISOString() }, null, now);
    expect(row).toMatchObject({ computer: "cmp_1", state: "sleeping", snapshotDaysLeft: 4, packaged: null });
    expect(inventoryRow({ id: "cmp_2", name: "x", size: "standard", state: "running", createdAt: "", lastActiveAt: "" }, null, now).snapshotDaysLeft).toBeNull();
  });

  it("writes the profile in the box's layout, leaves caches out and counts sites by domain only", () => {
    const script = packScript("dog-1");
    expect(script).toContain("--transform 's,^chromium,dog-1/chromium,'");
    expect(script).toContain("--exclude='*/Cache'");
    expect(script).toContain("select distinct host_key from cookies");
    expect(script).not.toMatch(/select[^\n]*value/);
    expect(script).toContain("--transform 's,^\\.,dog-1/home/.,'");
    for (const login of [".config/gh", ".ssh", ".npmrc", ".git-credentials"]) expect(script).toContain(`"$HOME/${login}"`);
  });

  it("reads what the computer reported and refuses anything partial", () => {
    const sha = "a".repeat(64);
    expect(readPacked(`sha256 ${sha}\nbytes 1234\nsites 17\ncli gh  npm\npart.000 part.001 `)).toEqual({ sha256: sha, bytes: 1234, sites: 17, cli: ["gh", "npm"], parts: ["part.000", "part.001"] });
    expect(readPacked("none\n")).toBe("none");
    expect(readPacked(`sha256 nope\nbytes 1\nsites 0\ncli \npart.000`)).toBeNull();
    expect(readPacked(`sha256 ${sha}\nbytes 1\nsites 0\ncli \n`)).toBeNull();
  });

  it("reports which computers could retire, and never one that woke after its move or was never moved", () => {
    const now = Date.parse("2026-12-20T00:00:00Z");
    const view = (id: string, state: "sleeping" | "running", lastActiveAt: string) => ({ id, name: id, size: "standard" as const, state, createdAt: "2026-10-01T00:00:00Z", lastActiveAt });
    const rows = retirementCheck([
      view("cmp_old", "sleeping", "2026-11-27T10:00:00Z"),
      view("cmp_woke", "sleeping", "2026-12-01T00:00:00Z"),
      view("cmp_recent", "sleeping", "2026-12-10T00:00:00Z"),
      view("cmp_awake", "running", "2026-11-27T10:00:00Z"),
      view("cmp_never", "sleeping", "2026-11-01T00:00:00Z"),
    ], [
      { dog: "a", from: "cmp_old", savedAt: "2026-11-27T12:00:00Z", sha256: "x" },
      { dog: "b", from: "cmp_woke", savedAt: "2026-11-27T12:00:00Z", sha256: "x" },
      { dog: "c", from: "cmp_recent", savedAt: "2026-12-15T00:00:00Z", sha256: "x" },
      { dog: "d", from: "cmp_awake", savedAt: "2026-11-27T12:00:00Z", sha256: "x" },
    ], now);
    expect(rows.map((row) => [row.computer, row.retirable])).toEqual([["cmp_old", true], ["cmp_woke", false], ["cmp_recent", false], ["cmp_awake", false], ["cmp_never", false]]);
    expect(rows[1]?.reason).toMatch(/woke after/);
    expect(rows[4]?.reason).toMatch(/not been moved/);
  });

  it("only moves computers that belong to the caller", async () => {
    const never = new Proxy({}, { get() { throw new Error("reached"); } }) as never;
    const owner = { person: "registry", trial: false, computers: async () => [], computer: () => never };
    const refused = await boxRequest({ op: "move", dog: "dog-1", computer: "cmp_other" }, new Request("https://x"), { boxes: { idFromName: () => "id", get: () => ({}) } as never, state: never }, owner);
    expect(refused.status).toBe(404);
  });
});
