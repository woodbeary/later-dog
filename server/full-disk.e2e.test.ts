import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-laterdog.ts";

const enabled = process.platform === "darwin" && process.env.LATERDOG_FULL_DISK_CHECK === "1";

const PLAIN_FULL = /^Your Mac is almost out of space, so later\.dog couldn't save that\. Free up some space and try again\.$/;

async function onSmallDisk(
  engine: NodeJS.ProcessEnv,
  run: (disk: { url: string; fill(): void; free(): void; call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> }) => Promise<void>,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-full-disk-"));
  const image = join(scratch, "small.dmg");
  const volume = `ldfull${process.pid}`;
  const mount = `/Volumes/${volume}`;
  const filler = join(mount, "filler");
  execFileSync("hdiutil", ["create", "-size", "40m", "-fs", "Journaled HFS+", "-volname", volume, image], { stdio: "pipe" });
  execFileSync("hdiutil", ["attach", image, "-nobrowse"], { stdio: "pipe" });
  const previousTmp = process.env.TMPDIR;
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    process.env.TMPDIR = `${mount}/`;
    fixture = await launchVerificationServer({ ...process.env, ...engine });
    expect(fixture.info.dataDir.startsWith(mount)).toBe(true);
    const { url } = fixture.info;
    await run({
      url,
      fill: () => { try { execFileSync("dd", ["if=/dev/zero", `of=${filler}`, "bs=64k"], { stdio: "pipe" }); } catch {} },
      free: () => rmSync(filler, { force: true }),
      call: async (method, path, body) => {
        const response = await fetch(url + path, {
          method, headers: { origin: url, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
        });
        return { status: response.status, body: await response.json() as any };
      },
    });
  } finally {
    rmSync(filler, { force: true });
    await fixture?.close();
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    try { execFileSync("hdiutil", ["detach", mount, "-force"], { stdio: "pipe" }); } catch {}
    rmSync(scratch, { recursive: true, force: true });
  }
}

const userTexts = (messages: any[]) => messages.filter((message) => message.role === "user").map((message) => message.text);

describe.skipIf(!enabled)("a full disk", () => {
  it("is said in plain words, loses nothing already saved, and recovers when space returns", async () => {
    await onSmallDisk({}, async ({ fill, free, call }) => {
      const bot = (await call("POST", "/api/bots", { name: "Full disk" })).body.bot;
      expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "before it fills", threadId: bot.threadId, sendId: "full_disk_before_0001" })).status).toBe(202);
      await delay(2_500);

      fill();

      const sendId = "full_disk_while_full_001";
      const refused = await call("POST", `/api/bots/${bot.id}/messages`, { text: "while it is full", threadId: bot.threadId, sendId });
      expect(refused.status).toBe(500);
      expect(refused.body.error).toMatch(PLAIN_FULL);
      const rename = await call("PATCH", `/api/bots/${bot.id}`, { name: "Renamed while full" });
      expect(rename.status).toBe(500);
      expect(rename.body.error).toMatch(PLAIN_FULL);
      expect((await call("GET", "/api/health")).status).toBe(200);
      expect(userTexts((await call("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages)).toEqual(["before it fills"]);

      free();
      await delay(1_000);
      expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "while it is full", threadId: bot.threadId, sendId })).status).toBe(202);
      await delay(2_500);
      expect(userTexts((await call("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages)).toEqual(["before it fills", "while it is full"]);
    });
  }, 120_000);

  it("does not take the server down when a turn ends while it is full", async () => {
    const gate = join(mkdtempSync(join(tmpdir(), "laterdog-full-disk-gate-")), "gate");
    try {
      await onSmallDisk({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_FINISH_GATE: gate }, async ({ fill, free, call }) => {
        const bot = (await call("POST", "/api/bots", { name: "Full mid turn" })).body.bot;
        expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "work", threadId: bot.threadId })).status).toBe(202);
        await delay(2_500);

        fill();
        writeFileSync(gate, "go");
        await delay(4_000);
        expect((await call("GET", "/api/health")).status).toBe(200);

        free();
        const idle = async () => (await call("GET", "/api/bots")).body.bots.find((candidate: any) => candidate.id === bot.id)?.tasks?.find((task: any) => task.threadId === bot.threadId)?.busy === false;
        for (let tries = 0; tries < 30 && !(await idle()); tries += 1) await delay(1_000);
        expect(await idle()).toBe(true);
        const next = await call("POST", `/api/bots/${bot.id}/messages`, { text: "again", threadId: bot.threadId });
        expect(next.status).toBe(202);
        expect(next.body.queued).toBeUndefined();
        await delay(2_500);
        const messages = (await call("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages;
        expect(userTexts(messages)).toEqual(["work", "again"]);
        expect(messages.filter((message: any) => message.role === "bot" && message.text === "fixture turn completed")).toHaveLength(2);
      });
    } finally {
      rmSync(join(gate, ".."), { recursive: true, force: true });
    }
  }, 120_000);
});
