import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleComputerRun } from "./computer-run-route.ts";
import { ComputerRuns, WAIT_IN_ONE_CALL_MS, type RunBox } from "./computer-runs.ts";
import { STILL_RUNNING_TAIL_CHARS, waitCapMs, waitWindowMs } from "./run-wait.ts";

const MINUTE = 60_000;

function job(endsAfterMs: number) {
  const root = mkdtempSync(join(tmpdir(), "run-wait-"));
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, "site/check.ts"), "export const check = 1;\n");
  const clock = { at: 1_000_000 };
  const endsAt = clock.at + endsAfterMs;
  const log = "x".repeat(12_000);
  const box: RunBox = {
    async exec(command) {
      if (command.startsWith("cat runs/.logs/")) return { exitCode: 0, stdout: clock.at >= endsAt ? `0\n<<<\n${log}` : `<<<\n${log}`, stderr: "" };
      if (command.includes("nohup")) return { exitCode: 0, stdout: "started\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async write() {},
    async read() { return Buffer.alloc(0); },
  };
  const runs = new ComputerRuns(join(root, "state"), { now: () => clock.at, sleep: async (ms) => { clock.at += ms; } });
  const computer = async () => ({ box });
  async function waitOut(extra: Record<string, unknown>, maxWaitMs?: number) {
    const texts: string[] = [];
    let body: Record<string, unknown> = { command: "pnpm gate", folder: join(root, "site"), ...extra };
    for (let call = 0; call < 50; call += 1) {
      const answer = await handleComputerRun({ botId: "dog", body, workingFolder: null, allowedRoots: [], home: root, ...(maxWaitMs ? { maxWaitMs } : {}) }, { runs, computer, now: () => clock.at });
      texts.push(answer.text ?? "");
      const still = /^Still running.*run_id ([0-9a-f]{8})/.exec(answer.text ?? "");
      if (!still) break;
      body = { run_id: still[1], ...extra };
    }
    return texts;
  }
  return { waitOut };
}

describe("waiting for a computer job with one call", () => {
  it("waits for a job that ends after 50 minutes in one call, where the 4-minute window took 13", async () => {
    const polled = await job(50 * MINUTE).waitOut({});
    expect(polled).toHaveLength(13);
    const waited = await job(50 * MINUTE).waitOut({ wait_minutes: 60 }, waitCapMs("claudeAgent", 10));
    expect(waited).toHaveLength(1);
    expect(waited[0]).toMatch(/^Finished on your cloud computer with exit code 0/);
  });

  it("keeps a still-running answer short and gives the whole tail once the job ends", async () => {
    const texts = await job(10 * MINUTE).waitOut({});
    expect(texts[0]).toMatch(/^Still running/);
    expect(texts[0].length).toBeLessThan(STILL_RUNNING_TAIL_CHARS + 600);
    expect(texts.at(-1)!.length).toBeGreaterThan(12_000);
  });

  it("never waits longer than the engine lets a tool call last, and keeps the old window when no wait is asked", () => {
    expect(waitCapMs("claudeAgent", 10)).toBe(60 * MINUTE);
    expect(waitCapMs("codex", 10)).toBe(9 * MINUTE);
    expect(waitCapMs("codex", 3)).toBe(WAIT_IN_ONE_CALL_MS);
    expect(waitCapMs(undefined, 120)).toBe(60 * MINUTE);
    expect(waitWindowMs(undefined, 60 * MINUTE)).toBe(WAIT_IN_ONE_CALL_MS);
    expect(waitWindowMs(30, 60 * MINUTE)).toBe(30 * MINUTE);
    expect(waitWindowMs(500, 60 * MINUTE)).toBe(60 * MINUTE);
    expect(waitWindowMs(60, 9 * MINUTE)).toBe(9 * MINUTE);
    expect(waitWindowMs(60)).toBe(WAIT_IN_ONE_CALL_MS);
    expect(waitWindowMs("60", 60 * MINUTE)).toBe(WAIT_IN_ONE_CALL_MS);
    expect(waitWindowMs(0.5, 60 * MINUTE)).toBe(WAIT_IN_ONE_CALL_MS);
  });
});
