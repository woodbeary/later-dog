import { describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { CHECK_NEEDS_UNATTENDED, createDeviceApprovalCardRoutes, createDeviceApprovalRequestRoute } from "./device-approval.ts";
import type { DeviceApprovalCardData } from "../../shared/device-approval.ts";
import type { DeviceApprovalWait } from "../laterdog/device-approval.ts";

const NOW = Date.UTC(2026, 10, 8, 20);

function harness(opts: { mayRunCheck?: boolean } = {}) {
  const messages: Message[] = [];
  const watched: DeviceApprovalWait[] = [];
  const unwatched: string[] = [];
  const notes: string[] = [];
  const route = createDeviceApprovalRequestRoute({
    owner: () => ({}),
    mayRunCheck: () => opts.mayRunCheck ?? true,
    cwd: () => "/work",
    messages: {
      activePath: () => messages,
      appendMessage: (_t: string, m: Omit<Message, "id" | "at">) => {
        const full = { ...m, id: `m${messages.length + 1}`, at: NOW } as Message;
        messages.push(full);
        return full;
      },
      patchMessage: (_t: string, id: string, patch: Partial<Message>) => {
        const at = messages.findIndex((m) => m.id === id);
        messages[at] = { ...messages[at]!, ...patch };
        return messages[at];
      },
    } as never,
    watch: (w) => watched.push(w),
    unwatch: (w) => unwatched.push(w.messageId),
    notify: (_s, _t, detail) => notes.push(detail),
    now: () => NOW,
  });
  const call = async (body: Record<string, unknown>) => {
    let status = 0;
    let out: Record<string, unknown> = {};
    await route({
      res: {} as never, path: "/api/internal/device-approval", method: "POST", url: new URL("http://x"), req: {} as never,
      json: ((_res: unknown, code: number, value: Record<string, unknown>) => { status = code; out = value; }) as never,
      sender: { id: "hound", name: "Hound", color: "#000" } as never, threadId: "t1", capability: {}, readBody: async () => body,
    });
    return { status, out };
  };
  return { call, messages, watched, unwatched, notes };
}

describe("device approval route", () => {
  it("posts a card with code, url and service, watches the check and tells the dog to end its turn", async () => {
    const h = harness();
    const { status, out } = await h.call({ service: "GitHub CLI", url: "https://github.com/login/device", code: "ABCD-1234", check: "gh auth status", expiresAt: "2026-11-08T20:15:00Z" });
    expect(status).toBe(201);
    expect(h.messages[0]!.card).toMatchObject({
      title: "Approve GitHub CLI sign-in",
      deviceApproval: { version: 1, service: "GitHub CLI", code: "ABCD-1234", url: "https://github.com/login/device", status: "waiting", watching: "check", expiresAt: NOW + 900_000 },
    });
    expect(h.watched).toEqual([{ botId: "hound", threadId: "t1", messageId: "m1", expiresAt: NOW + 900_000, check: "gh auth status", cwd: "/work" }]);
    expect(String(out.text)).toContain("End this turn");
    expect(h.notes[0]).toContain("ABCD-1234");
  });

  it("replaces an open card with a new code", async () => {
    const h = harness();
    await h.call({ service: "Codex", url: "https://auth.openai.com/codex/device", code: "AAAA-1111", pid: 400 });
    await h.call({ service: "Codex", url: "https://auth.openai.com/codex/device", code: "BBBB-2222", pid: 401 });
    expect(h.unwatched).toEqual(["m1"]);
    expect(h.messages[0]!.card!.deviceApproval).toMatchObject({ status: "ended", endedBy: "replaced" });
    expect(h.messages[1]!.card!.deviceApproval).toMatchObject({ status: "waiting", code: "BBBB-2222", watching: "process" });
    expect(h.watched[1]).toMatchObject({ pid: 401 });
  });

  it("refuses a check command where the chat asks before running things, and bad input", async () => {
    const h = harness({ mayRunCheck: false });
    expect(await h.call({ service: "x", url: "https://x.dev", check: "true" })).toMatchObject({ status: 403, out: { error: CHECK_NEEDS_UNATTENDED } });
    expect((await h.call({ service: "x", url: "https://x.dev", pid: 5 })).status).toBe(201);
    expect((await h.call({ url: "https://x.dev" })).status).toBe(400);
  });

  it("will not show a new code after the last one expired unused, until the person is back", async () => {
    const h = harness();
    await h.call({ service: "Cloudflare", url: "https://dash.cloudflare.com/oauth2/device/verify", code: "h3djWkhR", pid: 40 });
    h.messages[0]!.card!.deviceApproval = { ...h.messages[0]!.card!.deviceApproval!, status: "expired", endedBy: "expiry", renew: "offered" };
    const again = await h.call({ service: "Cloudflare", url: "https://dash.cloudflare.com/oauth2/device/verify", code: "VsRwAmye", pid: 41 });
    expect(again.status).toBe(409);
    expect(String(again.out.error)).toContain("End this turn now");
    expect(h.messages).toHaveLength(1);
    expect(h.watched).toHaveLength(1);
    h.messages.push({ id: "you", at: NOW, role: "user", kind: "text", text: "try again" } as Message);
    expect((await h.call({ service: "Cloudflare", url: "https://dash.cloudflare.com/oauth2/device/verify", code: "FWtQkLiR", pid: 42 })).status).toBe(201);
  });

  it("stops a dog that keeps replacing codes nobody used", async () => {
    const h = harness();
    expect((await h.call({ service: "Codex", url: "https://auth.openai.com/codex/device", code: "AAAA-1111", pid: 400 })).status).toBe(201);
    expect((await h.call({ service: "Codex", url: "https://auth.openai.com/codex/device", code: "BBBB-2222", pid: 401 })).status).toBe(201);
    expect((await h.call({ service: "Codex", url: "https://auth.openai.com/codex/device", code: "CCCC-3333", pid: 402 })).status).toBe(409);
    expect(h.messages).toHaveLength(2);
  });
});

describe("device approval card routes", () => {
  function cards(card: DeviceApprovalCardData) {
    let current = card;
    const renewed: string[] = [];
    const route = createDeviceApprovalCardRoutes({
      read: () => current,
      end: () => null,
      renew: (_bot, _thread, messageId) => {
        renewed.push(messageId);
        current = { ...current, renew: "asked" };
        return current;
      },
    });
    const call = async (action: string) => {
      let status = 0;
      let out: Record<string, unknown> = {};
      await route({
        req: {} as never, res: {} as never, path: `/api/bots/hound/device-approvals/m1/${action}`, method: "POST", url: new URL("http://x"),
        json: ((_res: unknown, code: number, value: Record<string, unknown>) => { status = code; out = value; }) as never,
        readBody: async () => ({ threadId: "t1" }),
      } as never);
      return { status, out };
    };
    return { call, renewed };
  }
  const base: DeviceApprovalCardData = { version: 1, service: "Cloudflare", url: "https://dash.cloudflare.com/oauth2/device/verify", code: "h3djWkhR", expiresAt: NOW, status: "expired", watching: "check", endedBy: "expiry" };

  it("gets a new code once when the person taps an expired card", async () => {
    const c = cards({ ...base, renew: "offered" });
    expect(await c.call("renew")).toMatchObject({ status: 200, out: { card: { renew: "asked" } } });
    expect(await c.call("renew")).toMatchObject({ status: 200, out: { card: { renew: "asked" } } });
    expect(c.renewed).toEqual(["m1"]);
  });

  it("has no new code to get on a card that did not expire unused", async () => {
    const c = cards({ ...base, status: "approved", endedBy: "person" });
    expect((await c.call("renew")).status).toBe(409);
    expect(c.renewed).toEqual([]);
  });
});
