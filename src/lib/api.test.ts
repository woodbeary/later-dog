import { afterEach, describe, expect, it, vi } from "vitest";
import { SAVED_HEADER, saveAnswer, savedAnswer, type DeskBucket, type DeskObject } from "../../deploy/laterdog/home/src/desk.ts";
import { WAKE_HEADER } from "../../deploy/laterdog/home/src/waking.ts";
import { SAVED_COPY_HEADER, WAKE_HEADER as DEVICE_WAKE_HEADER } from "../../shared/home-wake";
import { api, apiAnswer } from "./api";

function oneObjectBucket(): DeskBucket {
  let stored: { bytes: ArrayBuffer; httpMetadata: { contentType: string }; customMetadata: Record<string, string> } | null = null;
  return {
    async get(): Promise<DeskObject | null> {
      return stored ? { body: new Response(stored.bytes.slice(0)).body, httpMetadata: stored.httpMetadata, customMetadata: stored.customMetadata } : null;
    },
    async put(_key, value, options) { stored = { bytes: value, ...options }; },
    async delete() { stored = null; },
    async list() { return { objects: [], truncated: false }; },
  };
}

const fromHome = () => new Response(JSON.stringify({ bots: [] }), { headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("where an answer came from", () => {
  it("reads the same header names the edge writes", () => {
    expect(SAVED_COPY_HEADER).toBe(SAVED_HEADER);
    expect(DEVICE_WAKE_HEADER).toBe(WAKE_HEADER);
  });

  it("says an answer is the edge's saved copy only when the edge marked it", async () => {
    const bucket = oneObjectBucket();
    await saveAnswer(bucket, "chats", fromHome(), 1024, 5);
    const saved = await savedAnswer(bucket, "chats", 6);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(saved).mockResolvedValueOnce(fromHome()).mockResolvedValueOnce(fromHome()));
    expect(await apiAnswer("/api/bots")).toEqual({ body: { bots: [] }, savedCopy: true });
    expect(await apiAnswer("/api/bots")).toEqual({ body: { bots: [] }, savedCopy: false });
    expect(await api("/api/bots")).toEqual({ bots: [] });
  });

  it("treats an answer with no readable headers as the home's own", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    expect(await apiAnswer("/api/config")).toEqual({ body: { ok: true }, savedCopy: false });
  });
});
