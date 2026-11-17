import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";
import { request } from "../../scripts/mcp-server.ts";
import { postAndWait } from "../drivers/agents-client.ts";
import { startFakeComputers } from "../testing/fake-computers.ts";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const MINUTE = 60_000;

async function fixture(test: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "review2-server-"));
  const fake = await startFakeComputers(root);
  const session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_ROOM_MS: "1500000" }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const keyFile = join(root, "key");
    writeFileSync(keyFile, "ldc_reviewtestkey12345\n");
    writeFileSync(join(session.info.dataDir, "computers.json"), JSON.stringify({ api: fake.url, keyFile }));
    const bot = (await cli("new-bot", "--name", "Waiter")).bot;
    const gate = join(root, "release");
    writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { steps: [], gateFile: gate, reply: "finished waiting" } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "start and hold");
    let harness: { url: string; token: string } | undefined;
    for (let i = 0; i < 300 && !harness; i += 1) {
      await sleep(200);
      try {
        const dump = JSON.parse(readFileSync(session.fixtureDumpPath, "utf8"));
        const server = Object.values(dump.mcpConfig?.mcpServers ?? {}).find((entry: any) => entry?.env?.LATERDOG_COMMS_TOKEN) as any;
        if (server) harness = { url: server.env.LATERDOG_HARNESS_URL, token: server.env.LATERDOG_COMMS_TOKEN };
      } catch {}
    }
    expect(harness).toBeTruthy();
    const call = (body: Record<string, unknown>, waitMs: number, signal?: AbortSignal) =>
      postAndWait(`${harness!.url}/api/internal/computer-run`, harness!.token, JSON.stringify(body), waitMs, signal);
    const release = () => writeFileSync(gate, "go");
    const settle = async (seconds: number) => {
      const end = Date.now() + seconds * 1000;
      for (;;) {
        const result = await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "60");
        if (result.status === "settled" || Date.now() > end) return result;
      }
    };
    await test({ fake, cli, api, bot, call, release, settle });
  } finally { await session.close(); await fake.close(); }
}

it("a 6-minute wait for a 5.5-minute job is one call that finishes it", () => fixture(async (f) => {
  const began = Date.now();
  const answer = await f.call({ command: "sleep 330; echo done", wait_minutes: 6 }, 8 * MINUTE);
  const seconds = Math.round((Date.now() - began) / 1000);
  expect(answer.status).toBe(200);
  expect(String(answer.body.text)).toMatch(/^Finished on your cloud computer with exit code 0/);
  expect(seconds).toBeGreaterThan(320);
  f.release();
}), 700_000);

it("a message from the person ends a 5-minute wait within seconds, with the run_id", () => fixture(async (f) => {
  const pending = f.call({ command: "sleep 150; echo done", wait_minutes: 5 }, 7 * MINUTE);
  while (!f.fake.started()) await sleep(200);
  await sleep(15_000);
  const wroteAt = Date.now();
  await f.cli("send", "--bot", f.bot.id, "--task", f.bot.activeTaskId, "--text", "are you there? answer me please");
  const answer = await pending;
  const took = Math.round((Date.now() - wroteAt) / 1000);
  expect(String(answer.body.text)).toMatch(/^A new message arrived while you waited/);
  expect(String(answer.body.text)).toMatch(/run_id [0-9a-f]{8}/);
  expect(took).toBeLessThan(30);
  f.release();
}), 400_000);

it("stopping the turn mid-wait ends the call and the home stops polling the computer", () => fixture(async (f) => {
  const pending = f.call({ command: "sleep 200", wait_minutes: 5 }, 7 * MINUTE);
  while (!f.fake.started()) await sleep(200);
  await sleep(15_000);
  const stoppedAt = Date.now();
  await f.cli("interrupt", "--bot", f.bot.id, "--task", f.bot.activeTaskId);
  const answer = await pending;
  const took = Math.round((Date.now() - stoppedAt) / 1000);
  const atEnd = f.fake.polls();
  expect(atEnd).toBeGreaterThan(0);
  await sleep(35_000);
  expect(answer.status).toBe(409);
  expect(String(answer.body.error)).toMatch(/^The wait ended because this turn was stopped\. The job (is still running|stopped)/);
  expect(took).toBeLessThan(40);
  expect(f.fake.polls() - atEnd).toBeLessThanOrEqual(1);
}), 200_000);

it("when the caller hangs up, the home stops polling the computer", () => fixture(async (f) => {
  const cancel = new AbortController();
  const pending = f.call({ command: "sleep 200", wait_minutes: 5 }, 7 * MINUTE, cancel.signal).catch((error: Error) => error);
  while (!f.fake.started()) await sleep(200);
  await sleep(15_000);
  cancel.abort();
  await pending;
  await sleep(3_000);
  const atHangUp = f.fake.polls();
  expect(atHangUp).toBeGreaterThan(0);
  await sleep(40_000);
  expect(f.fake.polls() - atHangUp).toBeLessThanOrEqual(2);
  f.release();
}), 200_000);
