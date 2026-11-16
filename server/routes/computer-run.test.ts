import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ComputerRuns, type RunBox } from "../laterdog/computer-runs.ts";
import { isPoll, pollAnswer } from "../testing/poll-answer.ts";
import { COMPUTER_RUN_PATH, createComputerRunRoute } from "./computer-run.ts";
import type { InternalRouteContext } from "./internal.ts";

describe("the computer-run route", () => {
  it("stops waiting and answers nothing once the dog's call hangs up", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-route-gone-"));
    mkdirSync(join(root, "site"), { recursive: true });
    writeFileSync(join(root, "site/check.ts"), "export const check = 1;\n");
    const clock = { at: 1_000_000 };
    const res = Object.assign(new EventEmitter(), { writableEnded: false, headersSent: false });
    let polls = 0;
    const box: RunBox = {
      async exec(command) {
        if (isPoll(command)) {
          polls += 1;
          if (polls === 3) res.emit("close");
          return { exitCode: 0, stdout: pollAnswer(command, null, "working"), stderr: "" };
        }
        if (command.includes("nohup")) return { exitCode: 0, stdout: "started\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async write() {},
      async read() { return Buffer.alloc(0); },
    };
    const runs = new ComputerRuns(join(root, "state"), { now: () => clock.at, sleep: async (ms) => { clock.at += ms; } });
    const answered: unknown[] = [];
    const route = createComputerRunRoute({ owns: () => true, folders: () => [join(root, "site")], runs, computer: async () => ({ box }), now: () => clock.at, maxWaitMs: () => 60 * 60_000 });
    await route({
      res, path: COMPUTER_RUN_PATH, method: "POST", sender: { id: "dog" }, threadId: "t1", capability: {},
      json: (_res: unknown, status: number, body: unknown) => { answered.push({ status, body }); },
      readBody: async () => ({ command: "pnpm gate", folder: join(root, "site"), wait_minutes: 60 }),
    } as unknown as InternalRouteContext);
    expect(answered).toEqual([]);
    expect(polls).toBe(3);
    expect(clock.at - 1_000_000).toBeLessThan(60_000);
  });
});
