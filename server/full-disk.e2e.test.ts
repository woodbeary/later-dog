import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-laterdog.ts";

const enabled = process.platform === "darwin" && process.env.LATERDOG_FULL_DISK_CHECK === "1";

const PLAIN_FULL = /^Your Mac is almost out of space, so later\.dog couldn't save that\. Free up some space and try again\.$/;

it.skipIf(!enabled)("a full disk is said in plain words, loses nothing already saved, and recovers when space returns", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-full-disk-"));
  const image = join(scratch, "small.dmg");
  const volume = `ldfull${process.pid}`;
  const mount = `/Volumes/${volume}`;
  const previousTmp = process.env.TMPDIR;
  execFileSync("hdiutil", ["create", "-size", "40m", "-fs", "Journaled HFS+", "-volname", volume, image], { stdio: "pipe" });
  execFileSync("hdiutil", ["attach", image, "-nobrowse"], { stdio: "pipe" });
  const filler = join(mount, "filler");
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    process.env.TMPDIR = `${mount}/`;
    fixture = await launchVerificationServer({ ...process.env, TMPDIR: `${mount}/` });
    const { url } = fixture.info;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, {
        method, headers: { origin: url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
      });
      return { status: response.status, body: await response.json() as any };
    };
    const bot = (await call("POST", "/api/bots", { name: "Full disk" })).body.bot;
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "before it fills", threadId: bot.threadId, sendId: "full_disk_before_0001" })).status).toBe(202);
    await delay(2_500);

    try { execFileSync("dd", ["if=/dev/zero", `of=${filler}`, "bs=64k"], { stdio: "pipe" }); } catch {}

    const sendId = "full_disk_while_full_001";
    const refused = await call("POST", `/api/bots/${bot.id}/messages`, { text: "while it is full", threadId: bot.threadId, sendId });
    expect(refused.status).toBe(500);
    expect(refused.body.error).toMatch(PLAIN_FULL);
    const rename = await call("PATCH", `/api/bots/${bot.id}`, { name: "Renamed while full" });
    expect(rename.status).toBe(500);
    expect(rename.body.error).toMatch(PLAIN_FULL);
    expect((await call("GET", "/api/health")).status).toBe(200);
    const before = (await call("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages;
    expect(before.filter((message: any) => message.role === "user").map((message: any) => message.text)).toEqual(["before it fills"]);

    rmSync(filler, { force: true });
    await delay(1_000);
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "while it is full", threadId: bot.threadId, sendId })).status).toBe(202);
    await delay(2_500);
    const after = (await call("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages;
    expect(after.filter((message: any) => message.role === "user").map((message: any) => message.text)).toEqual(["before it fills", "while it is full"]);
  } finally {
    rmSync(filler, { force: true });
    await fixture?.close();
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    try { execFileSync("hdiutil", ["detach", mount, "-force"], { stdio: "pipe" }); } catch {}
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
