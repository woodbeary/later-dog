import { describe, expect, it } from "vitest";

import type { SharedComputerOperation } from "../shared-computers.ts";
import { createMacWaits, MAC_WAIT_CUT_SHORT, macResult, readMacReport, RUN_COMMAND_WAIT_SECONDS } from "./mac-waits.ts";

const COMMAND = "6f1c2d4e-8a9b-4c3d-9e2f-1a2b3c4d5e6f";
const THREAD = "thread-of-test-pup";

function fakeMac() {
  const calls: SharedComputerOperation[] = [];
  const replies: { resolve(report: Record<string, unknown>): void; reject(error: Error): void }[] = [];
  const send = (operation: SharedComputerOperation) => {
    calls.push(operation);
    return new Promise<unknown>((resolve, reject) => {
      replies.push({ resolve: (report) => resolve(macResult(report)), reject });
    });
  };
  return { calls, replies, send };
}

const output = (wait_seconds = 30): SharedComputerOperation => ({ action: "command_output", command_id: COMMAND, wait_seconds });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a dog waiting on a command on the person's Mac", () => {
  it("waits at most ten seconds when it starts a command, so a long wait happens where a message can end it", async () => {
    const waits = createMacWaits();
    const mac = fakeMac();
    for (const wait_seconds of [25, undefined, 3]) {
      const started = waits.run(THREAD, { action: "run_command", command: "pnpm build", ...(wait_seconds === undefined ? {} : { wait_seconds }) }, mac.send);
      mac.replies.at(-1)!.resolve({ command_id: COMMAND, running: true, output: "" });
      await started;
    }
    expect(mac.calls.map((call) => call.wait_seconds)).toEqual([RUN_COMMAND_WAIT_SECONDS, RUN_COMMAND_WAIT_SECONDS, 3]);
  });

  it("hands back the Mac's report unchanged when nobody writes in", async () => {
    const waits = createMacWaits();
    const mac = fakeMac();
    const checked = waits.run(THREAD, output(), mac.send);
    mac.replies[0]!.resolve({ command_id: COMMAND, running: false, exitCode: 0, output: "built\n", seconds: 41 });
    expect(readMacReport(await checked)).toEqual({ command_id: COMMAND, running: false, exitCode: 0, output: "built\n", seconds: 41 });
  });

  it("stops waiting when the person sends a message, and shows that wait's output first at the next check", async () => {
    const waits = createMacWaits();
    const mac = fakeMac();
    const checked = waits.run(THREAD, output(), mac.send);
    await settle();
    waits.messageSent(THREAD);
    expect(readMacReport(await checked)).toEqual({ command_id: COMMAND, waiting_cut_short: true, note: MAC_WAIT_CUT_SHORT });

    mac.replies[0]!.resolve({ command_id: COMMAND, running: true, output: "step 1 of 2\n", seconds: 30 });
    await settle();
    const next = waits.run(THREAD, output(), mac.send);
    mac.replies[1]!.resolve({ command_id: COMMAND, running: false, exitCode: 0, output: "step 2 of 2\n", seconds: 52 });
    expect(readMacReport(await next)).toEqual({ command_id: COMMAND, running: false, exitCode: 0, output: "step 1 of 2\nstep 2 of 2\n", seconds: 52 });
    expect(mac.calls).toHaveLength(2);
  });

  it("picks up the wait still on its way instead of asking the Mac a second time", async () => {
    const waits = createMacWaits();
    const mac = fakeMac();
    const checked = waits.run(THREAD, output(), mac.send);
    await settle();
    waits.messageSent(THREAD);
    await checked;

    const next = waits.run(THREAD, output(), mac.send);
    await settle();
    expect(mac.calls).toHaveLength(1);
    mac.replies[0]!.resolve({ command_id: COMMAND, running: false, exitCode: 1, output: "1 test failed\n", seconds: 33 });
    expect(readMacReport(await next)).toMatchObject({ running: false, exitCode: 1, output: "1 test failed\n" });
  });

  it("passes on output held from a cut-short wait when the next wait is cut short too", async () => {
    const waits = createMacWaits();
    const mac = fakeMac();
    const first = waits.run(THREAD, output(), mac.send);
    await settle();
    waits.messageSent(THREAD);
    await first;
    mac.replies[0]!.resolve({ command_id: COMMAND, running: true, output: "compiling\n" });
    await settle();

    const second = waits.run(THREAD, output(), mac.send);
    await settle();
    waits.messageSent(THREAD);
    expect(readMacReport(await second)).toMatchObject({ waiting_cut_short: true, output: "compiling\n" });
  });

  it("leaves the wait alone when a message goes to another dog", async () => {
    const waits = createMacWaits();
    const mac = fakeMac();
    const checked = waits.run(THREAD, output(), mac.send);
    await settle();
    waits.messageSent("thread-of-another-dog");
    mac.replies[0]!.resolve({ command_id: COMMAND, running: true, output: "still going\n" });
    expect(readMacReport(await checked)).toMatchObject({ running: true, output: "still going\n" });
  });

  it("reports the Mac's failure to the dog that is waiting", async () => {
    const waits = createMacWaits();
    const mac = fakeMac();
    const checked = waits.run(THREAD, output(), mac.send);
    mac.replies[0]!.reject(new Error("Computer disconnected"));
    await expect(checked).rejects.toThrow("Computer disconnected");
  });

  it("passes every other action straight through", async () => {
    const waits = createMacWaits();
    const mac = fakeMac();
    const read = waits.run(THREAD, { action: "read_file", path: "~/code/app/main.ts" }, mac.send);
    mac.replies[0]!.resolve({ content: "x" });
    expect(readMacReport(await read)).toEqual({ content: "x" });
    expect(mac.calls[0]).toEqual({ action: "read_file", path: "~/code/app/main.ts" });
  });
});
