import { describe, expect, it } from "vitest";
import { bootstrapSecret, homeIdentity, machineFromHost } from "../src/identity.ts";

const SECRET = "test-only-home-secret-with-plenty-of-length";
const SUFFIX = "-home.later.dog";

describe("home identity", () => {
  it("gives each account one stable, private address", async () => {
    const first = await homeIdentity(SECRET, "user-1", SUFFIX);
    const again = await homeIdentity(SECRET, "user-1", SUFFIX);
    const other = await homeIdentity(SECRET, "user-2", SUFFIX);
    expect(first).toEqual(again);
    expect(first.machineId).toMatch(/^h[0-9a-f]{24}$/);
    expect(first.origin).toBe(`https://${first.machineId}-home.later.dog`);
    expect(other.machineId).not.toBe(first.machineId);
    expect(first.machineId).not.toContain("user-1");
  });

  it("depends on the server secret, so addresses can't be guessed from account ids", async () => {
    const ours = await homeIdentity(SECRET, "user-1", SUFFIX);
    const guessed = await homeIdentity("someone-else-secret-of-the-same-length!!", "user-1", SUFFIX);
    expect(guessed.machineId).not.toBe(ours.machineId);
  });

  it("derives a 256-bit bootstrap secret the home accepts", async () => {
    const { machineId } = await homeIdentity(SECRET, "user-1", SUFFIX);
    const secret = await bootstrapSecret(SECRET, machineId);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await bootstrapSecret(SECRET, machineId)).toBe(secret);
  });

  it("maps only real home hosts back to a machine", async () => {
    const { machineId, host } = await homeIdentity(SECRET, "user-1", SUFFIX);
    expect(machineFromHost(host, SUFFIX)).toBe(machineId);
    expect(machineFromHost(host.toUpperCase(), SUFFIX)).toBe(machineId);
    expect(machineFromHost("accounts.later.dog", SUFFIX)).toBeNull();
    expect(machineFromHost("evil-home.later.dog", SUFFIX)).toBeNull();
    expect(machineFromHost(`${machineId}-home.later.dog.evil.test`, SUFFIX)).toBeNull();
  });

  it("refuses odd account ids", async () => {
    await expect(homeIdentity(SECRET, "../root", SUFFIX)).rejects.toThrow("invalid account id");
  });
});
