import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "../notify.ts";
import { createPhonePush, PUSH_LOG_FILE } from "./phone-push.ts";

const TOKEN = "ExponentPushToken[abcdefghij0123456789]";
const OTHER = "ExponentPushToken[zyxwvutsrq9876543210]";
const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "laterdog-phone-push-quiet-"));
  made.push(path);
  return path;
}
const approval: Notification = { kind: "approval", botId: "b1", botName: "Biscuit", threadId: "t1", title: "Biscuit needs approval", body: "Run the deploy script?" };
const ok = () => vi.fn(async () => Response.json({ data: [{ status: "ok" }, { status: "ok" }] }));
const sentTo = (fetcher: ReturnType<typeof ok>, call = 0): string[] =>
  JSON.parse(String((fetcher.mock.calls[call] as unknown as [string, RequestInit])[1].body)).map((message: { to: string }) => message.to);

describe("pings never go to a phone that is not the later.dog app", () => {
  it("sends nothing to tokens that never said they are the later.dog app", async () => {
    const dataDir = folder();
    const fetcher = ok();
    const push = createPhonePush({ dataDir, fetcher: fetcher as unknown as typeof fetch });
    push.register(TOKEN);
    push.register(OTHER);
    await push.send(approval);
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFileSync(join(dataDir, PUSH_LOG_FILE), "utf8")).toContain("held back");
  });

  it("sends only to the later.dog app when other tokens are still saved, and forgets them", async () => {
    const dataDir = folder();
    const fetcher = ok();
    const push = createPhonePush({ dataDir, fetcher: fetcher as unknown as typeof fetch });
    writeFileSync(join(dataDir, "phone-push.json"), `${JSON.stringify({ tokens: [OTHER, TOKEN], native: [TOKEN] })}\n`);
    await push.send(approval);
    expect(sentTo(fetcher)).toEqual([TOKEN]);
    expect(push.tokens()).toEqual([TOKEN]);
  });

  it("pushes the same pending approval once, even if it is announced again", async () => {
    const fetcher = ok();
    const push = createPhonePush({ dataDir: folder(), fetcher: fetcher as unknown as typeof fetch });
    push.register(TOKEN, "later.dog");
    await push.send({ ...approval, requestId: "r1" });
    await push.send({ ...approval, requestId: "r1" });
    await push.send({ ...approval, requestId: "r2" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("sends one 'needs your hands' for the same Mac window, naming every dog", async () => {
    const fetcher = ok();
    const waits: (() => void)[] = [];
    const push = createPhonePush({ dataDir: folder(), fetcher: fetcher as unknown as typeof fetch, later: (run) => waits.push(run) });
    push.register(TOKEN, "later.dog");
    const hands = (botName: string): Notification => ({ kind: "takeover", botId: botName, botName, threadId: `t-${botName}`, title: `${botName} needs your hands`, body: "Click Allow on your Mac: Accessibility window is waiting for you.", promptKey: "mac:universalAccessAuthWarn" });
    await push.send(hands("Headroom"));
    await push.send(hands("Desk"));
    await push.send(hands("Leash"));
    expect(fetcher).not.toHaveBeenCalled();
    waits[0]!();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [message] = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(message.title).toBe("Headroom, Desk and Leash need your hands");
    expect(message.body).toContain("Headroom, Desk and Leash are waiting on it.");
    await push.send(hands("Desk"));
    expect(waits.length).toBe(1);
  });
});
