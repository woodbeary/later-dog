import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../harness/registry.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";

const turn = { threadId: "t", text: "hello" } as never;

describe("no turn starts on an account the person switched off", () => {
  it("refuses every turn on a switched-off account, naming it, and leaves the rest of the engine working", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ off: { driver: "fake", displayName: "Claude account 1", enabled: false }, on: { driver: "fake", displayName: "Claude account 2" } });
    try {
      const off = registry.get("off")!;
      await expect(off.adapter.sendTurn(turn)).rejects.toMatchObject({ message: "Claude account 1 is turned off", code: "account_off", status: 409 });
      await expect(registry.get("on")!.adapter.sendTurn(turn)).resolves.toEqual({ turnId: "fake-turn" });
      expect(off.enabled).toBe(false);
      expect(off.adapter.hasSession("t")).toBe(false);
      await expect(off.snapshot()).resolves.toMatchObject({ state: "available" });
      const listener = vi.fn();
      expect(off.adapter.onEvent(listener)).toBeTypeOf("function");
    } finally {
      await registry.disposeAll();
    }
  });

  it("refuses under any decoration the home adds, and runs again once switched back on", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    const decorate = vi.fn((instance) => instance);
    try {
      await registry.load({ a: { driver: "fake", displayName: "Work", enabled: false } }, decorate);
      await expect(registry.get("a")!.adapter.sendTurn(turn)).rejects.toThrow("Work is turned off");
      await registry.load({ a: { driver: "fake", displayName: "Work", enabled: true } }, decorate);
      await expect(registry.get("a")!.adapter.sendTurn(turn)).resolves.toEqual({ turnId: "fake-turn" });
    } finally {
      await registry.disposeAll();
    }
  });
});
