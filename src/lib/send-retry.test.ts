import { describe, expect, it, vi } from "vitest";
import {
  SEND_RETRY_DELAYS_MS,
  SEND_UNCERTAIN_MESSAGE,
  UNCERTAIN_SEND_MEMORY_MS,
  UncertainSends,
  isTransportFailure,
  isUncertainSendFailure,
  sendWithRetry,
} from "./send-retry";

const apiError = (status: number) => Object.assign(new Error(`${status}`), { name: "ApiError", status });
const dropped = () => new TypeError("Failed to fetch");
const noSleep = () => Promise.resolve();

describe("a send that loses the network", () => {
  it("tells a network drop and a gateway hiccup from an answer the server meant", () => {
    expect(isTransportFailure(dropped())).toBe(true);
    expect(isTransportFailure(Object.assign(new Error("slow"), { name: "TimeoutError" }))).toBe(true);
    for (const status of [502, 503, 504]) expect(isTransportFailure(apiError(status))).toBe(true);
    for (const status of [400, 403, 409, 413, 500]) expect(isTransportFailure(apiError(status))).toBe(false);
    expect(isUncertainSendFailure(apiError(500))).toBe(true);
    expect(isUncertainSendFailure(apiError(409))).toBe(false);
    expect(isUncertainSendFailure(Object.assign(new Error("x"), { name: "SendUncertainError" }))).toBe(true);
  });

  it("tries again with the same request until the network returns, and sends once", async () => {
    const request = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(dropped())
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce("accepted");
    const onRetry = vi.fn();
    await expect(sendWithRetry(request, { sleep: noSleep, onRetry })).resolves.toBe("accepted");
    expect(request).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("waits longer each time", async () => {
    const sleeps: number[] = [];
    const request = vi.fn(async () => { throw dropped(); });
    await expect(sendWithRetry(request, { sleep: async (ms) => { sleeps.push(ms); } })).rejects.toThrow();
    expect(sleeps).toEqual([...SEND_RETRY_DELAYS_MS]);
    expect(request).toHaveBeenCalledTimes(SEND_RETRY_DELAYS_MS.length + 1);
  });

  it("gives up in plain words that say a second send will not duplicate", async () => {
    const request = vi.fn(async () => { throw dropped(); });
    const failure = await sendWithRetry(request, { sleep: noSleep }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(SEND_UNCERTAIN_MESSAGE);
    expect(SEND_UNCERTAIN_MESSAGE).not.toMatch(/fetch|network error|TypeError|\bthe user\b/i);
  });

  it("does not repeat an answer the server meant", async () => {
    const request = vi.fn(async () => { throw apiError(409); });
    await expect(sendWithRetry(request, { sleep: noSleep })).rejects.toMatchObject({ status: 409 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("remembering an uncertain send", () => {
  it("gives the same words in the same chat the same send id, so the server can drop a copy", () => {
    let now = 1_000;
    const sends = new UncertainSends(() => now);
    sends.remember("bot", "thread", "ship it", "send-id-one-0000000001");
    expect(sends.recall("bot", "thread", "ship it")).toBe("send-id-one-0000000001");
    expect(sends.recall("bot", "thread", "ship it now")).toBeUndefined();
    expect(sends.recall("bot", "other-thread", "ship it")).toBeUndefined();
    expect(sends.recall("other-bot", "thread", "ship it")).toBeUndefined();
    expect(sends.recall("bot", "thread", "ship it", "reply-to-1")).toBeUndefined();
    sends.forget("bot", "thread", "ship it");
    expect(sends.recall("bot", "thread", "ship it")).toBeUndefined();
    sends.remember("bot", "thread", "ship it", "send-id-two-0000000002");
    now += UNCERTAIN_SEND_MEMORY_MS + 1;
    expect(sends.recall("bot", "thread", "ship it")).toBeUndefined();
  });
});
