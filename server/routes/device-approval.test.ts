import { describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { CHECK_NEEDS_UNATTENDED, createDeviceApprovalRequestRoute } from "./device-approval.ts";
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
});
