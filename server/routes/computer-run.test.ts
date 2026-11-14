import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createComputerRunRoute, COMPUTER_RUN_PATH, type ComputerRunRouteDeps } from "./computer-run.ts";

function call(deps: Partial<ComputerRunRouteDeps>) {
  const sent: Array<[number, unknown]> = [];
  const route = createComputerRunRoute({
    owns: () => true,
    folders: () => ["/data/.laterdog/task-workspaces/dog/chat"],
    runs: {} as ComputerRunRouteDeps["runs"],
    computer: (async () => { throw new Error("no computer in this fixture"); }) as unknown as ComputerRunRouteDeps["computer"],
    ...deps,
  } as ComputerRunRouteDeps);
  return route({
    res: {} as ServerResponse, path: COMPUTER_RUN_PATH, method: "POST", sender: { id: "dog" }, threadId: "chat", capability: {},
    readBody: async () => ({ command: "ls" }),
    json: (_res: unknown, status: number, body: unknown) => { sent.push([status, body]); },
  } as never).then(() => sent);
}

describe("a computer run that starts in a chat's folder", () => {
  it("waits for the chat's files to come back and refuses plainly when they cannot yet", async () => {
    const asked: string[][] = [];
    const sent = await call({ ready: async (roots) => { asked.push(roots); return false; } });
    expect(asked).toEqual([["/data/.laterdog/task-workspaces/dog/chat"]]);
    expect(sent).toEqual([[503, { error: "This chat's files are still coming back from Cloud storage; try again in a moment." }]]);
  });
});
