import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FOLDER_NOT_SAVED } from "../laterdog/dog-folder.ts";
import { createDogFolderRoute, DOG_FOLDER_PATH } from "./dog-folder.ts";
import type { InternalRouteContext } from "./internal.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function call(route: ReturnType<typeof createDogFolderRoute>, body: unknown) {
  let answer: { status: number; body: unknown } | null = null;
  const context = {
    res: {}, path: DOG_FOLDER_PATH, method: "POST", sender: { id: "dog" }, threadId: "chat",
    json: (_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; },
    readBody: async () => body,
  } as unknown as InternalRouteContext;
  return route(context).then(() => answer!);
}

it("wakes the dog's computer before a change and not before a read, and leaves files alone when it cannot start", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "ld-folder-route-")));
  dirs.push(work);
  const woke: string[] = [];
  let starts = true;
  const route = createDogFolderRoute({
    owns: () => true, folders: () => [work], run: (_path, op) => op(),
    ready: async (botId, threadId) => { woke.push(`${botId}/${threadId}`); if (!starts) throw new Error("no"); },
  });
  expect((await call(route, { action: "write", path: "a.txt", content: "hi" })).status).toBe(200);
  expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("hi");
  expect((await call(route, { action: "read", path: "a.txt" })).status).toBe(200);
  expect(woke).toEqual(["dog/chat"]);
  starts = false;
  const refused = await call(route, { action: "delete", path: "a.txt" });
  expect(refused).toEqual({ status: 503, body: { error: FOLDER_NOT_SAVED } });
  expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("hi");
});
