import { describe, expect, it, vi } from "vitest";

import { readSecureCredentials } from "./secure-credentials.mjs";

const transient = () =>
  new Error("safeStorage.decryptStringAsync is temporarily unavailable. Please try again.");

const deps = (over = {}) => ({
  exists: () => true,
  isAvailable: async () => true,
  readFile: () => Buffer.from("cipher"),
  decrypt: async () => JSON.stringify({ composioApiKey: "ak_live" }),
  sleep: async () => {},
  ...over,
});

describe("readSecureCredentials", () => {
  it("reports an empty store when no file was ever written", async () => {
    const result = await readSecureCredentials(deps({ exists: () => false }));
    expect(result).toEqual({ status: "empty", credentials: {} });
  });

  it("returns the stored credentials when the store opens", async () => {
    const result = await readSecureCredentials(deps());
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("tries again when the OS says the store is temporarily unavailable", async () => {
    const decrypt = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(JSON.stringify({ composioApiKey: "ak_live" }));
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(decrypt).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("waits between attempts instead of hammering the keychain", async () => {
    const slept = [];
    const decrypt = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("{}");
    await readSecureCredentials(deps({ decrypt, sleep: async (ms) => slept.push(ms) }));
    expect(slept).toEqual([100]);
  });

  it("says UNAVAILABLE — never empty — when every attempt fails", async () => {
    const decrypt = vi.fn().mockRejectedValue(transient());
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(result.credentials).toEqual({});
    expect(result.error).toMatch(/temporarily unavailable/);
    expect(decrypt.mock.calls.length).toBeGreaterThan(1);
  });

  it("says UNAVAILABLE when the OS store itself is switched off", async () => {
    const result = await readSecureCredentials(deps({ isAvailable: async () => false }));
    expect(result.status).toBe("unavailable");
  });

  it("says UNAVAILABLE for a file it cannot parse, rather than pretending it is empty", async () => {
    const decrypt = vi.fn().mockResolvedValue("not json");
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});


describe("same-keychain fallback", () => {
  it("recovers through the compatible OS API when the async encryptor stays unavailable", async () => {
    const decryptFallback = vi.fn().mockReturnValue(JSON.stringify({ existing: "preserved" }));
    const result = await readSecureCredentials(deps({
      decrypt: vi.fn().mockRejectedValue(new Error("ciphertext unavailable")),
      decryptFallback,
    }));
    expect(result).toEqual({ status: "ok", credentials: { existing: "preserved" }, usedFallback: true });
    expect(decryptFallback).toHaveBeenCalledExactlyOnceWith(Buffer.from("cipher"));
  });

  it("does not invoke a blocking fallback when async decryption succeeds", async () => {
    const decryptFallback = vi.fn();
    expect((await readSecureCredentials(deps({ decryptFallback }))).status).toBe("ok");
    expect(decryptFallback).not.toHaveBeenCalled();
  });

  it.each(["not json", "null", "[]"])("rejects invalid fallback documents: %s", async (text) => {
    const result = await readSecureCredentials(deps({
      decrypt: vi.fn().mockRejectedValue(new Error("ciphertext unavailable")),
      decryptFallback: () => text,
    }));
    expect(result.status).toBe("unavailable");
    expect(result.credentials).toEqual({});
  });
});

describe("readSecureCredentials with a key that no longer matches", () => {
  const wrongKey = () => new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.");
  const stale = (over = {}) => deps({
    decrypt: async () => { throw wrongKey(); },
    setAside: vi.fn(),
    probe: async () => true,
    now: () => new Date("2026-10-15T12:30:45.000Z"),
    ...over,
  });

  it("sets the file aside and reports reset when the current key works", async () => {
    const options = stale();
    const result = await readSecureCredentials(options);
    expect(options.setAside).toHaveBeenCalledWith("credentials.bin.unreadable-2026-10-15T12-30-45.000Z");
    expect(result).toEqual({ status: "reset", credentials: {}, setAsideAs: "credentials.bin.unreadable-2026-10-15T12-30-45.000Z" });
  });

  it("leaves the file alone and stays unavailable when the probe fails", async () => {
    const options = stale({ probe: async () => { throw new Error("keychain locked"); } });
    const result = await readSecureCredentials(options);
    expect(options.setAside).not.toHaveBeenCalled();
    expect(result.status).toBe("unavailable");
  });

  it("stays unavailable when the file cannot be renamed", async () => {
    const result = await readSecureCredentials(stale({ setAside: () => { throw new Error("EACCES"); } }));
    expect(result.status).toBe("unavailable");
  });
});
