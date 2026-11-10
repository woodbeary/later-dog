import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "../notify.ts";
import { createPhonePush, EXPO_PUSH_URL, EXPO_RECEIPTS_URL, PUSH_LOG_FILE, phonePushRequest } from "./phone-push.ts";

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
    expect(await phonePushRequest("POST", async () => ({ token: TOKEN }), push)).toEqual({ status: 200, body: { ok: true, registered: true, app: "untagged" } });
    expect(push.tokens()).toEqual([TOKEN]);
    expect((await phonePushRequest("POST", async () => ({ token: "nope" }), push)).status).toBe(400);
    expect((await phonePushRequest("PUT", async () => ({}), push)).status).toBe(405);
    await phonePushRequest("DELETE", async () => ({ token: TOKEN }), push);
    expect(push.tokens()).toEqual([]);
  });
});

describe("pings go to the later.dog app, not Expo Go", () => {
  it("drops tokens from before the app said which app it is once the later.dog app registers", () => {
    const push = createPhonePush({ dataDir: folder() });
    push.register(OTHER);
    push.register(TOKEN, "later.dog");
    expect(push.tokens()).toEqual([TOKEN]);
    expect(push.register(OTHER)).toBe(false);
    expect(push.tokens()).toEqual([TOKEN]);
  });

  it("never sends to a token Expo Go registers, and forgets it if it was saved before", () => {
    const push = createPhonePush({ dataDir: folder() });
    push.register(OTHER);
    expect(push.register(OTHER, "expo-go")).toBe(false);
    expect(push.tokens()).toEqual([]);
  });

  it("keeps every device the later.dog app registered", () => {
    const push = createPhonePush({ dataDir: folder() });
    push.register(TOKEN, "later.dog");
    push.register(OTHER, "later.dog");
    expect(push.tokens()).toEqual([TOKEN, OTHER]);
    push.unregister(TOKEN);
    push.register(TOKEN, "later.dog");
    expect(push.tokens()).toEqual([OTHER, TOKEN]);
  });

  it("reads the app from the registration request", async () => {
    const push = createPhonePush({ dataDir: folder() });
    push.register(OTHER);
    await phonePushRequest("POST", async () => ({ token: TOKEN, app: "later.dog" }), push);
    expect(push.tokens()).toEqual([TOKEN]);
  });
});

describe("why a ping did not arrive is visible", () => {
  const now = () => new Date("2026-11-10T18:00:00Z");
  const immediately = (run: () => void) => run();

  it("logs the push service's refusal for a phone, which used to be dropped silently", async () => {
    const dataDir = folder();
    const warn = vi.fn();
    const fetcher = vi.fn(async () => Response.json({ data: [{ status: "error", message: "Could not find APNs credentials for dog.later.phone", details: { error: "InvalidCredentials" } }] }));
    const push = createPhonePush({ dataDir, fetcher: fetcher as unknown as typeof fetch, warn, now, later: immediately });
    push.register(TOKEN, "later.dog");
    const report = await push.send(approval);
    expect(report).toEqual({ phones: 1, accepted: 0, errors: ["…456789 InvalidCredentials: Could not find APNs credentials for dog.later.phone"] });
    const log = readFileSync(join(dataDir, PUSH_LOG_FILE), "utf8");
    expect(log).toContain("register …456789 from later.dog: kept");
    expect(log).toContain("ping (approval) to …456789: InvalidCredentials");
    expect(log).not.toContain(TOKEN);
    expect(push.tokens()).toEqual([TOKEN]);
  });

  it("checks Expo's receipts later and forgets a phone Apple no longer knows", async () => {
    const dataDir = folder();
    const fetcher = vi.fn(async (url: string) => url === EXPO_RECEIPTS_URL
      ? Response.json({ data: { a: { status: "error", details: { error: "DeviceNotRegistered" } }, b: { status: "ok" } } })
      : Response.json({ data: [{ status: "ok", id: "a" }, { status: "ok", id: "b" }] }));
    const pending: Array<() => void> = [];
    const push = createPhonePush({ dataDir, fetcher: fetcher as unknown as typeof fetch, warn: () => undefined, now, later: (run) => pending.push(run) });
    push.register(TOKEN, "later.dog");
    push.register(OTHER, "later.dog");
    expect(await push.send(approval)).toEqual({ phones: 2, accepted: 2, errors: [] });
    expect(push.tokens()).toEqual([TOKEN, OTHER]);
    pending.shift()?.();
    await vi.waitFor(() => expect(push.tokens()).toEqual([OTHER]));
    expect(readFileSync(join(dataDir, PUSH_LOG_FILE), "utf8")).toContain("receipt for …456789: DeviceNotRegistered");
  });

  it("logs when the later.dog app takes over from older tokens", () => {
    const dataDir = folder();
    const push = createPhonePush({ dataDir, now });
    push.register(OTHER);
    push.register(TOKEN, "later.dog");
    push.register(OTHER);
    const log = readFileSync(join(dataDir, PUSH_LOG_FILE), "utf8");
    expect(log).toContain("register …456789 from later.dog: kept; stopped sending to …543210");
    expect(log).toContain("register …543210 without an app name: not kept, the later.dog app is registered");
  });

  it("keeps the log small", () => {
    const dataDir = folder();
    const push = createPhonePush({ dataDir, now });
    for (let index = 0; index < 1500; index += 1) push.unregister(TOKEN);
    const log = readFileSync(join(dataDir, PUSH_LOG_FILE), "utf8");
    expect(log.length).toBeLessThanOrEqual(64 * 1024);
    expect(log.trimEnd().split("\n").length).toBeLessThanOrEqual(1500);
  });

  it("tells the phone whether it is registered", async () => {
    const push = createPhonePush({ dataDir: folder() });
    const ask = (token: string) => phonePushRequest("GET", async () => ({}), push, new URL(`https://home/api/phone/push?token=${encodeURIComponent(token)}`));
    expect(await ask(TOKEN)).toEqual({ status: 200, body: { registered: false, app: null } });
    expect(await phonePushRequest("POST", async () => ({ token: TOKEN, app: "later.dog" }), push)).toEqual({ status: 200, body: { ok: true, registered: true, app: "later.dog" } });
    expect(await ask(TOKEN)).toEqual({ status: 200, body: { registered: true, app: "later.dog" } });
    expect((await ask("nope")).status).toBe(400);
  });

  it("sends a real test ping and reports what Expo said, receipts included", async () => {
    const fetcher = vi.fn(async (url: string) => url === EXPO_RECEIPTS_URL
      ? Response.json({ data: { r1: { status: "error", message: "bad device token", details: { error: "InvalidCredentials" } } } })
      : Response.json({ data: [{ status: "ok", id: "r1" }] }));
    const push = createPhonePush({ dataDir: folder(), fetcher: fetcher as unknown as typeof fetch, warn: () => undefined, now, later: immediately });
    expect(await push.test()).toEqual({ phones: 0, accepted: 0, errors: ["No phone is registered for pings."] });
    push.register(TOKEN, "later.dog");
    expect(await push.test()).toEqual({ phones: 1, accepted: 0, errors: ["…456789 InvalidCredentials: bad device token"] });
    const sent = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent).toEqual([{ to: TOKEN, title: "Test ping", body: "Pings from your dogs reach this phone.", sound: "default", data: { kind: "test" } }]);
  });
});


describe("test ping receipt outages", () => {
  it("reports a receipt lookup failure instead of calling the test successful", async () => {
    const fetcher = vi.fn(async (url: string) => url === EXPO_RECEIPTS_URL
      ? new Response("unavailable", { status: 503 })
      : Response.json({ data: [{ status: "ok", id: "r1" }] }));
    const push = createPhonePush({ dataDir: folder(), fetcher: fetcher as unknown as typeof fetch, warn: () => undefined, later: (run) => run() });
    push.register(TOKEN, "later.dog");
    expect(await push.test()).toEqual({ phones: 1, accepted: 0, errors: ["receipts: the push service answered 503"] });
  });
});
