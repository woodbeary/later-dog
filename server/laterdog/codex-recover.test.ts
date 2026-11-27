import { expect, it } from "vitest";
import { recoverCodexRolloutFrom } from "./codex-recover.ts";

it("fetches the one cut-off session file for a chat's cursor from the computer and ignores anything ambiguous", async () => {
  const cursor = "0f8b7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  const commands: string[] = [];
  const box = (found: string) => ({
    exec: async (command: string) => { commands.push(command); return { exitCode: 0, stdout: found }; },
    read: async (path: string) => Buffer.from(`bytes of ${path}`),
  });
  const path = `/data/.laterdog/engine-launch/run/sessions/2026/11/26/rollout-2026-11-26T16-34-57-${cursor}.jsonl`;
  expect(await recoverCodexRolloutFrom(box(path + "\n"), "/data/.laterdog/engine-launch", cursor)).toEqual({
    name: `2026/11/26/rollout-2026-11-26T16-34-57-${cursor}.jsonl`, bytes: Buffer.from(`bytes of ${path}`),
  });
  expect(commands[0]).toContain(`'rollout-*-${cursor}.jsonl'`);
  expect(await recoverCodexRolloutFrom(box(`${path}\n${path}.copy\n`), "/data/.laterdog/engine-launch", cursor)).toBeNull();
  expect(await recoverCodexRolloutFrom(box(""), "/data/.laterdog/engine-launch", cursor)).toBeNull();
  expect(await recoverCodexRolloutFrom(box(path), "/data/.laterdog/engine-launch", "not-a-cursor; rm -rf /")).toBeNull();
});
