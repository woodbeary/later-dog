import { describe, expect, it } from "vitest";
import type { DeviceApprovalCardData } from "../../shared/device-approval.ts";
import {
  DEVICE_APPROVAL_UNANSWERED_MAX,
  deviceApprovalHeldText,
  deviceApprovalHold,
  deviceApprovalNeedsYou,
  deviceApprovalRenewable,
  deviceApprovalRenewPrompt,
} from "./device-approval-wait.ts";

const card = (over: Partial<DeviceApprovalCardData> = {}): DeviceApprovalCardData => ({
  version: 1, service: "Cloudflare", url: "https://dash.cloudflare.com/oauth2/device/verify", code: "h3djWkhR",
  expiresAt: 1, status: "waiting", watching: "check", ...over,
});
const shown = (over: Partial<DeviceApprovalCardData> = {}, from?: string) => ({ role: "bot", kind: "options", ...(from ? { from: { botId: from } } : {}), card: { deviceApproval: card(over) } });
const expired = (over: Partial<DeviceApprovalCardData> = {}) => shown({ status: "expired", endedBy: "expiry", renew: "offered", ...over });
const person = { role: "user", kind: "text" };
const said = { role: "bot", kind: "text" };

describe("a sign-in code the person has not used", () => {
  it("holds the dog once a code expired unused, until the person writes or asks for a new code", () => {
    const loop = [person, said, expired(), said];
    expect(deviceApprovalHold(loop, "dog", false)).toMatchObject({ kind: "expired" });
    expect(deviceApprovalHold([...loop, person], "dog", false)).toBeNull();
    expect(deviceApprovalHold([person, said, expired({ renew: "asked" }), said], "dog", false)).toBeNull();
  });

  it("refuses a third code in a row the person has not used, even before one expires", () => {
    const replaced = shown({ status: "ended", endedBy: "replaced" });
    expect(deviceApprovalHold([person, replaced], "dog", false)).toBeNull();
    expect(DEVICE_APPROVAL_UNANSWERED_MAX).toBe(2);
    expect(deviceApprovalHold([person, replaced, shown()], "dog", false)).toMatchObject({ kind: "unanswered", count: 2 });
    expect(deviceApprovalHold([person, replaced, shown({ status: "approved", endedBy: "check" })], "dog", false)).toBeNull();
  });

  it("counts only the asking dog's cards in a group", () => {
    expect(deviceApprovalHold([person, expired({}), said].map((m) => ({ ...m, from: { botId: "other" } })), "dog", true)).toBeNull();
    expect(deviceApprovalHold([person, { ...expired(), from: { botId: "dog" } }], "dog", true)).toMatchObject({ kind: "expired" });
  });

  it("tells the dog to stop and say what it waits for, never to refresh", () => {
    const text = deviceApprovalHeldText({ kind: "expired", card: card() });
    expect(text).toContain("Do not start another login");
    expect(text).toContain("End this turn now");
    expect(text).toContain("Get a new code");
    expect(deviceApprovalRenewPrompt(card())).toContain("asked for a fresh");
  });

  it("says the chat is waiting on the person while a code is open or expired unused", () => {
    expect(deviceApprovalNeedsYou([person, shown()])).toBe("Approve the Cloudflare sign-in");
    expect(deviceApprovalNeedsYou([person, expired()])).toBe("Approve the Cloudflare sign-in");
    expect(deviceApprovalNeedsYou([person, expired({ renew: "asked" })])).toBeUndefined();
    expect(deviceApprovalNeedsYou([expired(), person])).toBeUndefined();
    expect(deviceApprovalNeedsYou([person, shown({ status: "approved", endedBy: "person" })])).toBeUndefined();
  });

  it("offers a new code only on a card that expired unused", () => {
    expect(deviceApprovalRenewable(card({ status: "expired", renew: "offered" }))).toBe(true);
    expect(deviceApprovalRenewable(card({ status: "expired", renew: "asked" }))).toBe(false);
    expect(deviceApprovalRenewable(card({ status: "ended" }))).toBe(false);
  });
});
