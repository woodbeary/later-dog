import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

  it("keeps the home's key and record when they are already in place", async () => {
    const laterdog = home();
    await seedIncluded(laterdog, { key: KEY, api: "https://cloud.later.dog/v1" }, null);
    expect(await seedIncluded(laterdog, { key: KEY, api: "https://cloud.later.dog/v1" }, null)).toBe("kept");
    expect(readFileSync(join(laterdog, "computers-trial-key"), "utf8")).toBe(`${KEY}\n`);
  });

  it("replaces a public free-trial key the home started on its own with the home's key", async () => {
    const laterdog = home();
    mkdirSync(laterdog, { recursive: true });
    writeFileSync(join(laterdog, "computers-trial-key"), `ldt_${"p".repeat(43)}\n`, { mode: 0o644 });
    writeFileSync(join(laterdog, "computers-trial.json"), `${JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true })}\n`);
    expect(await seedIncluded(laterdog, { key: KEY, api: "https://cloud.later.dog/v1" }, null)).toBe("replaced");
    expect(readFileSync(join(laterdog, "computers-trial-key"), "utf8").trim()).toBe(KEY);
    expect(JSON.parse(readFileSync(join(laterdog, "computers-trial.json"), "utf8"))).toEqual({
      api: "https://cloud.later.dog/v1",
      confirmed: true,
      included: ["decisions", "voice", "ai"],
    });
    expect(statSync(join(laterdog, "computers-trial-key")).mode & 0o777).toBe(0o600);
  });

  it("brings back a renewed key that a restored backup had marked as ended", async () => {
    const laterdog = home();
    mkdirSync(laterdog, { recursive: true });
    writeFileSync(join(laterdog, "computers-trial-key"), `${KEY}\n`);
    writeFileSync(join(laterdog, "computers-trial.json"), `${JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true, ended: true })}\n`);
    expect(await seedIncluded(laterdog, { key: KEY, api: "https://cloud.later.dog/v1" }, null)).toBe("replaced");
    expect(JSON.parse(readFileSync(join(laterdog, "computers-trial.json"), "utf8"))).not.toHaveProperty("ended");
  });

  it("never writes through a link a dog left where the key or record belongs", async () => {
    const laterdog = home();
    mkdirSync(laterdog, { recursive: true });
    const outside = join(dirname(laterdog), "outside.txt");
    writeFileSync(outside, "keep me\n", { mode: 0o644 });
    symlinkSync(outside, join(laterdog, "computers-trial-key"));
    symlinkSync(outside, join(laterdog, "computers-trial.json"));
    expect(await seedIncluded(laterdog, { key: KEY, api: "https://cloud.later.dog/v1" }, null)).toBe("seeded");
    expect(readFileSync(outside, "utf8")).toBe("keep me\n");
    expect(statSync(outside).mode & 0o777).toBe(0o644);
    for (const name of ["computers-trial-key", "computers-trial.json"]) expect(lstatSync(join(laterdog, name)).isFile()).toBe(true);
    expect(readFileSync(join(laterdog, "computers-trial-key"), "utf8").trim()).toBe(KEY);
  });

  it("puts a real folder back when the home's folder is a link", async () => {
    const laterdog = home();
    const elsewhere = join(dirname(laterdog), "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, laterdog);
    expect(await seedIncluded(laterdog, { key: KEY, api: "https://cloud.later.dog/v1" }, null)).toBe("seeded");
    expect(lstatSync(laterdog).isDirectory()).toBe(true);
    expect(() => lstatSync(join(elsewhere, "computers-trial-key"))).toThrow();
  });

  it("does nothing without a well-formed key", async () => {
    expect(await seedIncluded(home(), { key: "nope", api: "https://cloud.later.dog/v1" }, null)).toBe("skipped");
    expect(await seedIncluded(home(), { key: undefined, api: undefined }, null)).toBe("skipped");
  });
});
