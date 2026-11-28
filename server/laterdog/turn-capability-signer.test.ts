import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityKey, verifyCapability } from "../../shared/signed-capability.ts";
import { turnCapabilitySigner } from "./turn-capability-signer.ts";
import { OFF, mergeCoordinatorSetting, queueModeFor, readCoordinatorSetting, saveCoordinatorSetting } from "./coordinator-setting.ts";

const home = "hfeedfacecafe";
const secret = "test-bootstrap-secret";
const grant = { dog: "dog-1", chat: "chat-1", generation: "gen-1", kind: "agents" as const };

describe("turn capability signer", () => {
  it("signs a token the edge verifies with the same bootstrap secret", async () => {
    const token = turnCapabilitySigner({ home, bootstrapSecret: secret }).sign(grant, 60_000)!;
    const check = await verifyCapability(await capabilityKey(secret), token, { home, now: Date.now(), kinds: ["agents"] });
    expect(check.ok && check.claims).toMatchObject({ home, ...grant });
  });

  it("refuses forged, tampered, expired and other homes' tokens", () => {
    let at = 1_000_000;
    const signer = turnCapabilitySigner({ home, bootstrapSecret: secret, now: () => at });
    const token = signer.sign(grant, 60_000)!;
    expect(signer.genuine(token)).toBe(true);
    expect(signer.genuine(`${token.slice(0, -2)}AA`)).toBe(false);
    expect(turnCapabilitySigner({ home, bootstrapSecret: "other" }).genuine(token)).toBe(false);
    expect(turnCapabilitySigner({ home: "hother", bootstrapSecret: secret, now: () => at }).genuine(token)).toBe(false);
    at += 60_001;
    expect(signer.genuine(token)).toBe(false);
  });

  it("reads only signed bearers and leaves random tokens to the legacy check", () => {
    const signer = turnCapabilitySigner({ home, bootstrapSecret: secret });
    const token = signer.sign(grant, 60_000)!;
    expect(signer.presented(`Bearer ${token}`)).toBe(token);
    expect(signer.presented(`Bearer ${"a".repeat(48)}`)).toBeNull();
  });

  it("gives no token for identifiers the claims cannot carry", () => {
    expect(turnCapabilitySigner({ home, bootstrapSecret: secret }).sign({ ...grant, chat: "has space" }, 60_000)).toBeNull();
  });
});

describe("coordinator setting", () => {
  it("is off by default and survives a save", () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-setting-"));
    expect(readCoordinatorSetting(dir)).toEqual(OFF);
    const on = mergeCoordinatorSetting(OFF, { capabilities: "signed", queue: { "dog-1": "object" } });
    saveCoordinatorSetting(dir, on);
    expect(readCoordinatorSetting(dir)).toEqual(on);
    expect(queueModeFor(on, "dog-1")).toBe("object");
    expect(queueModeFor(on, "dog-2")).toBe("container");
    const all = mergeCoordinatorSetting(on, { queue: { "*": "object", "dog-1": null } });
    expect(all.queue).toEqual({ "*": "object" });
    expect(queueModeFor(all, "dog-2")).toBe("object");
  });
});
