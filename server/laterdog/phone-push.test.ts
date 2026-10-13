import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "../notify.ts";
import { createPhonePush, EXPO_PUSH_URL, phonePushRequest } from "./phone-push.ts";

const TOKEN = "ExponentPushToken[abcdefghij0123456789]";
const OTHER = "ExponentPushToken[zyxwvutsrq9876543210]";
const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "laterdog-phone-push-"));
  made.push(path);
  return path;
}
const approval: Notification = { kind: "approval", botId: "b1", botName: "Biscuit", threadId: "t1", title: "Biscuit needs approval", body: "Run the deploy script?" };

describe("push notifications to the phone", () => {
  it("keeps only real Expo push tokens, without repeats", () => {
    const push = createPhonePush({ dataDir: folder() });
    expect(push.register("not a token")).toBe(false);
    expect(push.register(TOKEN)).toBe(true);
    expect(push.register(TOKEN)).toBe(true);
    expect(push.register(OTHER)).toBe(true);
    expect(push.tokens()).toEqual([TOKEN, OTHER]);
    push.unregister(TOKEN);
    expect(push.tokens()).toEqual([OTHER]);
  });

  it("sends a notification to every phone, urgent ones at high priority", async () => {
    const dataDir = folder();
    const fetcher = vi.fn(async () => Response.json({ data: [{ status: "ok" }] }));
    const push = createPhonePush({ dataDir, fetcher: fetcher as unknown as typeof fetch });
    push.register(TOKEN);
    await push.send(approval);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EXPO_PUSH_URL);
    expect(JSON.parse(String(init.body))).toEqual([{
      to: TOKEN,
      title: "Biscuit needs approval",
      body: "Run the deploy script?",
      sound: "default",
      data: { kind: "approval", botId: "b1", threadId: "t1" },
      priority: "high",
      interruptionLevel: "time-sensitive",
    }]);
    expect(readFileSync(join(dataDir, "phone-push.json"), "utf8")).toContain(TOKEN);
  });

  it("lets the person reply from the notification to a dog's message or question, never to an approval or hand-over", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ status: "ok" }] }));
    const push = createPhonePush({ dataDir: folder(), fetcher: fetcher as unknown as typeof fetch });
    push.register(TOKEN);
    const category = async (kind: Notification["kind"], threadId: string | undefined = "t1") => {
      fetcher.mockClear();
      await push.send({ ...approval, kind, threadId: threadId as string });
      return JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body))[0].categoryId;
    };
    expect(await category("done")).toBe("reply");
    expect(await category("question")).toBe("reply");
    expect(await category("approval")).toBeUndefined();
    expect(await category("takeover")).toBeUndefined();
    expect(await category("done", "")).toBeUndefined();
  });

  it("forgets a phone the push service says is gone, and survives an outage", async () => {
    const warn = vi.fn();
    const answers = [Response.json({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }, { status: "ok" }] })];
    const fetcher = vi.fn(async () => {
      const next = answers.shift();
      if (!next) throw new Error("offline");
      return next;
    });
    const push = createPhonePush({ dataDir: folder(), fetcher: fetcher as unknown as typeof fetch, warn });
    push.register(TOKEN);
    push.register(OTHER);
    await push.send({ ...approval, kind: "done", title: "Biscuit is done" });
    expect(push.tokens()).toEqual([OTHER]);
    await push.send(approval);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not reach the push service"));
  });

  it("does nothing when no phone asked for notifications", async () => {
    const fetcher = vi.fn();
    await createPhonePush({ dataDir: folder(), fetcher: fetcher as unknown as typeof fetch }).send(approval);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("answers the phone's register and remove requests", async () => {
    const push = createPhonePush({ dataDir: folder() });
    expect(await phonePushRequest("POST", async () => ({ token: TOKEN }), push)).toEqual({ status: 200, body: { ok: true } });
    expect(push.tokens()).toEqual([TOKEN]);
    expect((await phonePushRequest("POST", async () => ({ token: "nope" }), push)).status).toBe(400);
    expect((await phonePushRequest("GET", async () => ({}), push)).status).toBe(405);
    await phonePushRequest("DELETE", async () => ({ token: TOKEN }), push);
    expect(push.tokens()).toEqual([]);
  });
});
