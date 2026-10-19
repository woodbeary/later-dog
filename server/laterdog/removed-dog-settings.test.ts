import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REMOVED_DOG_SETTINGS_FILE, setAsideRemovedDogSettings, type RemovedDogSettings } from "./removed-dog-settings.ts";

describe("setting aside the removed send and per-app settings", () => {
  let dir: string;
  const at = (iso: string) => () => new Date(iso);
  const sidecar = () => JSON.parse(readFileSync(join(dir, REMOVED_DOG_SETTINGS_FILE), "utf8")) as RemovedDogSettings[];
  const dogs = () => [
    { id: "rex", name: "Rex", outbound: { policy: "allow", dailyCap: 5 }, connectorScopes: { apps: { gmail: "read" } } },
    { id: "ace", name: "Ace", connectorScopes: { apps: { slack: "write" } } },
    { id: "plain", name: "Plain" },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-removed-settings-"));
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes each dog's removed values to a file beside bots.json before taking them off the dog", () => {
    const bots = dogs();
    expect(setAsideRemovedDogSettings(dir, bots, at("2026-10-19T12:00:00.000Z"))).toBe(true);
    expect(sidecar()).toEqual([
      { id: "rex", name: "Rex", outbound: { policy: "allow", dailyCap: 5 }, connectorScopes: { apps: { gmail: "read" } }, removedAt: "2026-10-19T12:00:00.000Z" },
      { id: "ace", name: "Ace", connectorScopes: { apps: { slack: "write" } }, removedAt: "2026-10-19T12:00:00.000Z" },
    ]);
    expect(bots).toEqual([{ id: "rex", name: "Rex" }, { id: "ace", name: "Ace" }, { id: "plain", name: "Plain" }]);
    expect(readdirSync(dir)).toEqual([REMOVED_DOG_SETTINGS_FILE]);
  });

  it("does nothing when no dog holds them", () => {
    expect(setAsideRemovedDogSettings(dir, [{ id: "plain", name: "Plain" }])).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("appends on later boots without writing the same values twice", () => {
    setAsideRemovedDogSettings(dir, dogs(), at("2026-10-19T12:00:00.000Z"));
    expect(setAsideRemovedDogSettings(dir, dogs(), at("2026-10-20T12:00:00.000Z"))).toBe(true);
    expect(sidecar()).toHaveLength(2);
    const changed = [{ id: "rex", name: "Rex", outbound: { policy: "ask" } }];
    setAsideRemovedDogSettings(dir, changed, at("2026-10-21T12:00:00.000Z"));
    expect(sidecar()).toHaveLength(3);
    expect(sidecar()[2]).toEqual({ id: "rex", name: "Rex", outbound: { policy: "ask" }, removedAt: "2026-10-21T12:00:00.000Z" });
    expect(changed).toEqual([{ id: "rex", name: "Rex" }]);
  });

  it("keeps a damaged file as a copy and starts a fresh one", () => {
    writeFileSync(join(dir, REMOVED_DOG_SETTINGS_FILE), "{ not json");
    expect(setAsideRemovedDogSettings(dir, dogs(), at("2026-10-19T12:00:00.000Z"))).toBe(true);
    expect(sidecar().map((entry) => entry.id)).toEqual(["rex", "ace"]);
    const copies = readdirSync(dir).filter((name) => name.startsWith(`${REMOVED_DOG_SETTINGS_FILE}.damaged-`));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]!), "utf8")).toBe("{ not json");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("leaves the values on the dogs when the file cannot be written", () => {
    chmodSync(dir, 0o500);
    const bots = dogs();
    expect(setAsideRemovedDogSettings(dir, bots)).toBe(false);
    expect(bots).toEqual(dogs());
  });
});
