import { describe, expect, it, vi } from "vitest";

import { acceptedSendMatch, landedSend, parseSendId, sendFingerprint, SendSequencer, type LandedSendSources, type QueuedSend } from "./send-idempotency.ts";
import type { Message } from "./store.ts";

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    at: 1,
    role: "user",
    kind: "text",
    text: "ship it",
    sendId: "send_1234567890123456",
    ...overrides,
  };
}

describe("send idempotency", () => {
  it("accepts bounded client ids and rejects malformed input", () => {
    expect(parseSendId(undefined)).toBeUndefined();
    expect(parseSendId("send_1234567890123456")).toBe("send_1234567890123456");
    expect(() => parseSendId("short")).toThrow(/client-generated id/);
    expect(() => parseSendId("spaces are not ids 1234")).toThrow(/client-generated id/);
  });

  it("returns only an exact canonical user-message receipt", () => {
    const sendId = "send_1234567890123456";
    const message = userMessage({ replyToId: "reply-1" });
    expect(acceptedSendMatch([message], sendId, "ship it", "reply-1")).toEqual({
      kind: "match",
      message,
    });
    expect(acceptedSendMatch([message], sendId, "different", "reply-1")).toEqual({
      kind: "conflict",
    });
    expect(acceptedSendMatch([message], "send_9999999999999999", "ship it", "reply-1")).toEqual({
      kind: "none",
    });
  });

  it("matches a stored message from an older build that still carries a channel mode", () => {
    const sendId = "send_1234567890123456";
    const message = { ...userMessage(), channelMode: "goal" } as Message;
    expect(acceptedSendMatch([message], sendId, "ship it")).toEqual({ kind: "match", message });
    expect(sendFingerprint("ship it")).toBe(sendFingerprint("ship it", undefined));
  });

  it("coalesces simultaneous retries onto one operation", async () => {
    const sequencer = new SendSequencer();
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const fingerprint = sendFingerprint("first", undefined);
    const first = sequencer.run("same", fingerprint, async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
      return 1;
    });
    const secondWork = vi.fn(async () => {
      order.push("second");
      return 2;
    });
    const second = sequencer.run("same", fingerprint, secondWork);
    await Promise.resolve();
    expect(secondWork).not.toHaveBeenCalled();
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(order).toEqual(["first:start", "first:end"]);
    expect(secondWork).not.toHaveBeenCalled();

    await expect(sequencer.run("same", fingerprint, secondWork)).resolves.toBe(2);
    expect(secondWork).toHaveBeenCalledOnce();
  });

  it("rejects a concurrent payload change and shares the first rejection", async () => {
    const sequencer = new SendSequencer();
    let rejectFirst = (_error: Error) => {};
    const gate = new Promise<number>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const firstWork = vi.fn(() => gate);
    const secondWork = vi.fn(async () => 2);
    const first = sequencer.run("same-error", "one", firstWork);
    const same = sequencer.run("same-error", "one", secondWork);
    await expect(sequencer.run("same-error", "different", secondWork)).rejects.toMatchObject({
      status: 409,
    });
    rejectFirst(new Error("transport lost"));
    await expect(first).rejects.toThrow("transport lost");
    await expect(same).rejects.toThrow("transport lost");
    expect(firstWork).toHaveBeenCalledOnce();
    expect(secondWork).not.toHaveBeenCalled();

    await expect(sequencer.run("same-error", "one", secondWork)).resolves.toBe(2);
  });

  describe("landed send", () => {
    const sendId = "send_1234567890123456";
    const sources = (overrides: Partial<{ messages: Message[]; queued: QueuedSend | null; cancelled: boolean }> = {}): LandedSendSources => ({
      messages: () => overrides.messages ?? [],
      queued: (id) => (id === sendId ? overrides.queued ?? null : null),
      cancelled: (id) => id === sendId && overrides.cancelled === true,
    });

    it("answers a landed row with that row", () => {
      const message = userMessage({ replyToId: "reply-1" });
      expect(landedSend(sources({ messages: [message] }), sendId, "ship it", "reply-1")).toEqual({ kind: "accepted", message });
    });

    it("answers a queued entry with its receipt", () => {
      const queued: QueuedSend = { id: "queue-1", text: "ship it", reason: "capacity" };
      expect(landedSend(sources({ queued }), sendId, "ship it")).toEqual({ kind: "queued", queued });
    });

    it("keeps the 409 when the same id carries a different message", () => {
      const message = userMessage();
      expect(() => landedSend(sources({ messages: [message] }), sendId, "changed")).toThrow(expect.objectContaining({ status: 409 }));
      const queued: QueuedSend = { id: "queue-1", text: "ship it", replyToId: "reply-1" };
      expect(() => landedSend(sources({ queued }), sendId, "changed", "reply-1")).toThrow(/another message/);
      expect(() => landedSend(sources({ queued }), sendId, "ship it")).toThrow(/another message/);
    });

    it("refuses a cancelled queued id", () => {
      expect(() => landedSend(sources({ cancelled: true, messages: [userMessage()] }), sendId, "ship it"))
        .toThrow(expect.objectContaining({ status: 409, message: expect.stringMatching(/cancelled/) }));
    });

    it("treats a missing or unknown id as a new message", () => {
      const lookups = { messages: vi.fn(() => [userMessage()]), queued: vi.fn(() => null), cancelled: vi.fn(() => false) };
      expect(landedSend(lookups, undefined, "ship it")).toEqual({ kind: "new" });
      expect(lookups.messages).not.toHaveBeenCalled();
      expect(landedSend(sources({ messages: [userMessage()] }), "send_9999999999999999", "ship it")).toEqual({ kind: "new" });
    });
  });
});
