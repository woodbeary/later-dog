import { describe, expect, it, vi } from "vitest";
import { cardNeed, forwardNeedsYou, type NeedsYouHost } from "./delegated-needs-you.ts";
import type { WireMessage } from "../../shared/wire.ts";
import type { RoomHandoff } from "../room-handoffs.ts";

const node = (id: string, parentId?: string) => ({ id, botId: id, threadId: id, parentId, createdAt: 1 }) as RoomHandoff;
const form = (): WireMessage => ({ id: "card", at: 2, role: "bot", kind: "secret", secureForm: {
  title: "Sign in to Cloudflare", host: "cloudflare.com", status: "open", fields: [{ id: "password", label: "Password", type: "password" }],
} });

describe("delegated cards", () => {
  it("forwards exact targets through every ancestor once and updates them after an answer", () => {
    const root = node("clover");
    const middle = node("hound", "clover");
    const child = node("kennel", "hound");
    const rows: Record<string, WireMessage[]> = { kennel: [form()], hound: [], clover: [] };
    const host: NeedsYouHost = {
      messages: id => rows[id], name: id => id, allowed: () => true, notify: vi.fn(),
      append: (id, needsYou) => { rows[id].push({ id: "proxy", at: 3, role: "bot", kind: "text", needsYou }); },
      patch: (id, messageId, needsYou) => { rows[id].find(row => row.id === messageId)!.needsYou = needsYou; },
    };
    expect(forwardNeedsYou(child, [root, middle, child], host)).toBe(true);
    expect(forwardNeedsYou(child, [root, middle, child], host)).toBe(true);
    expect(host.notify).toHaveBeenCalledTimes(2);
    expect(rows.clover[0].needsYou).toEqual({ botId: "kennel", botName: "kennel", threadId: "kennel", messageId: "card", label: "Sign in to Cloudflare", status: "waiting" });
    expect(JSON.stringify(rows.clover)).not.toContain("password");
    rows.kennel[0].secureForm!.status = "filled";
    expect(forwardNeedsYou(child, [root, middle, child], host)).toBe(false);
    expect(rows.clover[0].needsYou?.status).toBe("answered");
    expect(rows.hound[0].needsYou?.status).toBe("answered");
  });
  it("blocks forwarding across an invalid route and ignores older cards", () => {
    const child = node("kennel", "clover");
    const host: NeedsYouHost = { messages: () => [form()], name: id => id, allowed: () => false, notify: vi.fn(), append: vi.fn(), patch: vi.fn() };
    expect(forwardNeedsYou(child, [node("clover"), child], host)).toBe(true);
    expect(host.append).not.toHaveBeenCalled();
    child.createdAt = 3;
    expect(forwardNeedsYou(child, [node("clover"), child], host)).toBe(false);
  });
  it("normalizes credential, device and takeover dismissals", () => {
    const base: WireMessage = { id: "c", at: 2, role: "bot", kind: "options" };
    expect(cardNeed({ ...base, secret: { label: "Cloudflare", dismissed: true } as WireMessage["secret"] })?.status).toBe("dismissed");
    expect(cardNeed({ ...base, card: { deviceApproval: { service: "GitHub", status: "waiting" } } as WireMessage["card"] })?.status).toBe("waiting");
    expect(cardNeed({ ...base, card: { takeoverRequest: { step: "Approve passkey", status: "in-control" } } as WireMessage["card"] })?.status).toBe("waiting");
    expect(cardNeed({ ...base, card: { dismissed: true, takeoverRequest: { step: "Approve passkey", status: "waiting" } } as WireMessage["card"] })?.status).toBe("dismissed");
  });
});
