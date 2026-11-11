import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url));
const REPLY = "A reply long enough to arrive in a good number of small pieces.";
const ask = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

type Line = { type: string; event?: { delta?: { text?: string } }; message?: { content?: Array<{ type: string; text?: string }> } };

let scratch: string;
let engine: ChildProcessWithoutNullStreams | null;
let printed: string;

function start(plan: { everyMs: number; chars: number }, env: Record<string, string> = {}) {
  const streamFile = join(scratch, "stream.json");
  writeFileSync(streamFile, JSON.stringify(plan));
  const { FAKE_CLAUDE_TOOL_CALLS: _scriptedCalls, ...inherited } = process.env;
  engine = spawn(process.execPath, ["--experimental-strip-types", CLI, "-p", "--output-format", "stream-json", "--input-format", "stream-json"], {
    env: { ...inherited, FAKE_CLAUDE_REPLIES: JSON.stringify([REPLY]), FAKE_CLAUDE_STREAM_FILE: streamFile, ...env },
  });
  printed = "";
  engine.stdout.on("data", (chunk) => { printed += chunk; });
  return engine;
}

const lines = (): Line[] => printed.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Line);
const pieces = () => lines().filter((line) => line.type === "stream_event").map((line) => line.event?.delta?.text ?? "");
const finished = () => lines().some((line) => line.type === "result");

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "fake-claude-stream-"));
  engine = null;
});

afterEach(async () => {
  if (engine && engine.exitCode === null && engine.signalCode === null) {
    const gone = once(engine, "exit");
    engine.kill("SIGKILL");
    await gone;
  }
  rmSync(scratch, { recursive: true, force: true });
});

it("streams a reply in pieces when only the stream file is set", async () => {
  const child = start({ everyMs: 1, chars: 7 });
  child.stdin.write(ask("Say something long."));
  await expect.poll(finished, { timeout: 10_000 }).toBe(true);
  expect(pieces().length).toBe(Math.ceil(REPLY.length / 7));
  expect(pieces().join("")).toBe(REPLY);
  const order = lines().map((line) => line.type);
  const whole = lines().findIndex((line) => line.type === "assistant" && line.message?.content?.[0]?.text === REPLY);
  expect(whole).toBeGreaterThan(order.lastIndexOf("stream_event"));
  expect(order.indexOf("result")).toBeGreaterThan(whole);
});

it("keeps reading what the person sends while a reply is still streaming", async () => {
  const received = join(scratch, "steer-received");
  const child = start({ everyMs: 60, chars: 2 }, { FAKE_CLAUDE_STEER_RECEIVED: received });
  child.stdin.write(ask("Say something long."));
  await expect.poll(() => pieces().length, { timeout: 10_000 }).toBeGreaterThan(0);
  child.stdin.write(ask("One more thing."));
  await expect.poll(() => existsSync(received) || finished(), { timeout: 10_000 }).toBe(true);
  expect(finished()).toBe(false);
  expect(pieces().length).toBeLessThan(Math.ceil(REPLY.length / 2));
});

it("answers a stop signal in the middle of a streamed reply", async () => {
  const child = start({ everyMs: 60, chars: 2 }, { FAKE_CLAUDE_EXIT_DELAY_MS: "20" });
  child.stdin.write(ask("Say something long."));
  await expect.poll(() => pieces().length, { timeout: 10_000 }).toBeGreaterThan(0);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exited;
  expect(code).toBe(0);
  expect(finished()).toBe(false);
  expect(pieces().length).toBeLessThan(Math.ceil(REPLY.length / 2));
});
