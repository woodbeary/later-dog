import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SCREEN_FRAME, SHARED_ACTIONS, SharedComputers, sharedActionsHeader, sharedComputerOperation } from "./shared-computers.ts";

const secret = "a".repeat(64);
const alice = { session: "owner", person: "p_alice" };
const registration = (computer: boolean) => ({ id: randomUUID(), name: "Mac", environmentId: randomUUID(), folders: [], terminal: false, computer });

describe("live screen frames from a lent Mac", () => {
  it("asks a Mac for a frame only when it can send one and its screen is lent", async () => {
    const broker = new SharedComputers(() => true);
    const old = registration(true); broker.register(old, alice, secret, sharedActionsHeader(SHARED_ACTIONS.join(",")));
    expect(broker.canShowScreen(alice.person, old.id)).toBe(false);
    const noScreen = registration(false); broker.register(noScreen, alice, secret, sharedActionsHeader([...SHARED_ACTIONS, SCREEN_FRAME].join(",")));
    expect(broker.canShowScreen(alice.person, noScreen.id)).toBe(false);
    const ready = registration(true); broker.register(ready, alice, secret, sharedActionsHeader([...SHARED_ACTIONS, SCREEN_FRAME].join(",")));
    expect(broker.canShowScreen(alice.person, ready.id)).toBe(true);
    const frame = broker.screenFrame(alice.person, ready.id, () => true);
    const job = await broker.poll(ready.id, alice.session, secret);
    expect(job?.operation).toEqual({ action: SCREEN_FRAME, computer_id: ready.id });
    expect(job).not.toHaveProperty("by");
    broker.complete(ready.id, alice.session, secret, job!.id, { png: "eA==", format: "jpeg" });
    await expect(frame).resolves.toEqual({ png: "eA==", format: "jpeg" });
    await expect(broker.screenFrame(alice.person, old.id, () => true)).rejects.toThrow();
    broker.close();
  });

  it("never lets a dog ask for a frame itself", () => {
    expect(sharedComputerOperation.safeParse({ action: SCREEN_FRAME }).success).toBe(false);
  });
});
