import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedIncluded } from "../runtime/included.mjs";

const KEY = `ldt_${"a".repeat(43)}`;
const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
function home(): string {
  const path = mkdtempSync(join(tmpdir(), "laterdog-included-"));
  made.push(path);
  return join(path, ".laterdog");
}

describe("a new home's included services", () => {
  it("writes the key and the trial record the server reads", async () => {
    const laterdog = home();
    expect(await seedIncluded(laterdog, { key: KEY, api: "https://cloud.later.dog/v1" }, null)).toBe("seeded");
    expect(readFileSync(join(laterdog, "computers-trial-key"), "utf8").trim()).toBe(KEY);
    expect(JSON.parse(readFileSync(join(laterdog, "computers-trial.json"), "utf8"))).toEqual({
      api: "https://cloud.later.dog/v1",
      confirmed: true,
      included: ["decisions", "voice", "ai"],
    });
    expect(statSync(join(laterdog, "computers-trial-key")).mode & 0o777).toBe(0o600);
  });

  it("never replaces a key the home already has", async () => {
    const laterdog = home();
    await seedIncluded(laterdog, { key: KEY, api: "https://cloud.later.dog/v1" }, null);
    writeFileSync(join(laterdog, "computers-trial-key"), "ldt_mine\n");
    expect(await seedIncluded(laterdog, { key: `ldt_${"b".repeat(43)}`, api: "https://cloud.later.dog/v1" }, null)).toBe("kept");
    expect(readFileSync(join(laterdog, "computers-trial-key"), "utf8")).toBe("ldt_mine\n");
  });

  it("does nothing without a well-formed key", async () => {
    expect(await seedIncluded(home(), { key: "nope", api: "https://cloud.later.dog/v1" }, null)).toBe("skipped");
    expect(await seedIncluded(home(), { key: undefined, api: undefined }, null)).toBe("skipped");
  });
});
