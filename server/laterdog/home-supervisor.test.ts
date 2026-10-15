import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createLaterDogRoutes } from "../routes/laterdog.ts";
import { PASS } from "../routes/table.ts";
import {
  NO_SUPERVISOR_ENV, NO_SUPERVISOR_FOR_DOGS, NO_SUPERVISOR_ON_MY_CLOUD, dogSupervisorEnvironment, supervisorMissingForDog, supervisorMissingOnHome,
} from "./home-supervisor.ts";
import { answerToolCall } from "./mcp.ts";

const NAMES = ["LATERDOG_SUPERVISOR_URL", "LATERDOG_TOKEN", "LATERDOG_TOKEN_FILE", "LATERDOG_HOME", "LATERDOG_DATA_DIR"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
const folders: string[] = [];
afterEach(() => {
  for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "laterdog-home-supervisor-"));
  folders.push(home);
  for (const name of NAMES) delete process.env[name];
  process.env.LATERDOG_HOME = home;
  return home;
}

describe("cloud jobs on a Cloud home, where no supervisor runs", () => {
  it("knows the supervisor is missing only on a Cloud home with nothing configured", () => {
    const home = emptyHome();
    expect(supervisorMissingOnHome(false)).toBe(false);
    expect(supervisorMissingOnHome(true)).toBe(true);
    process.env.LATERDOG_SUPERVISOR_URL = "https://supervisor.example.test";
    expect(supervisorMissingOnHome(true)).toBe(false);
    delete process.env.LATERDOG_SUPERVISOR_URL;
    writeFileSync(join(home, "supervisor.json"), JSON.stringify({ url: "https://supervisor.example.test", tokenFile: join(home, "token") }));
    expect(supervisorMissingOnHome(true)).toBe(false);
    expect(supervisorMissingOnHome(true, () => { throw new Error("broken supervisor.json"); })).toBe(true);
    expect(supervisorMissingOnHome(true, () => ({ source: "file" }))).toBe(false);
  });

  it("gives a dog's later.dog tools no supervisor address or token there, and makes no token file", () => {
    const home = emptyHome();
    const env = dogSupervisorEnvironment("dog-1", "thread-1", true);
    expect(env).toEqual({ [NO_SUPERVISOR_ENV]: "1", LATERDOG_BOT_ID: "dog-1", LATERDOG_CONVERSATION_ID: "thread-1" });
    expect(existsSync(join(home, "supervisor"))).toBe(false);
    process.env.LATERDOG_SUPERVISOR_URL = "https://supervisor.example.test";
    process.env.LATERDOG_TOKEN = "desktop-token";
    expect(dogSupervisorEnvironment("dog-1", "thread-1", false)).toMatchObject({ LATERDOG_SUPERVISOR_URL: "https://supervisor.example.test", LATERDOG_BOT_ID: "dog-1" });
  });

  it("answers a dog's delegate_cloud_job at once with what to do instead, without calling anything", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = { [NO_SUPERVISOR_ENV]: "1", LATERDOG_BOT_ID: "dog-1" };
    expect(supervisorMissingForDog(env)).toBe(NO_SUPERVISOR_FOR_DOGS);
    expect(supervisorMissingForDog({})).toBeNull();
    for (const name of ["delegate_cloud_job", "laterdog_workspace", "inspect_cloud_job"]) {
      expect(await answerToolCall(name, { title: "x" }, env)).toEqual({ isError: true, content: [{ type: "text", text: NO_SUPERVISOR_FOR_DOGS }] });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(NO_SUPERVISOR_FOR_DOGS).toContain("don't retry");
    expect(NO_SUPERVISOR_FOR_DOGS).toContain("clone the repository into your working folder, make a branch, commit, push and open a draft pull request with git and gh");
  });

  it("answers the app's cloud job routes with a clear 503 instead of pointing at a supervisor that isn't there", async () => {
    emptyHome();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const route = createLaterDogRoutes({ supervisorMissing: () => true });
    const answers: { status: number; body: unknown }[] = [];
    const res = {} as never;
    const reply = ((_res: unknown, status: number, body: unknown) => { answers.push({ status, body }); return true; }) as typeof json;
    for (const path of ["/api/laterdog/workspace", "/api/laterdog/jobs"]) {
      await route({ req: {} as never, res, url: new URL(path, "http://localhost"), path, method: "GET", auth: {} as RequestAuth, json: reply, readBody });
    }
    expect(answers).toEqual([{ status: 503, body: { error: NO_SUPERVISOR_ON_MY_CLOUD } }, { status: 503, body: { error: NO_SUPERVISOR_ON_MY_CLOUD } }]);
    expect(await route({ req: {} as never, res, url: new URL("http://localhost/api/laterdog/mac-accounts"), path: "/api/laterdog/mac-accounts", method: "GET", auth: {} as RequestAuth, json: reply, readBody })).toBe(PASS);
    expect(fetcher).not.toHaveBeenCalled();
    expect(NO_SUPERVISOR_ON_MY_CLOUD).toContain("connected in Settings");
  });
});
