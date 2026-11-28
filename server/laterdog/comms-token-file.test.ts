import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarnessClient } from "../drivers/agents-client.ts";
import { commsTokenByFile, commsTokenFile, commsTokenFromEnv, writeTurnCommsToken } from "./comms-token-file.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("moves the turn capability out of the engine's settings into a private file the tools read on every call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comms-token-"));
  dirs.push(dir);
  const file = commsTokenFile(dir, "thread-1", "bot-1");
  const first = commsTokenByFile({ command: "node", env: { LATERDOG_THREAD_ID: "thread-1", LATERDOG_COMMS_TOKEN: "one" } }, file);
  const second = commsTokenByFile({ command: "node", env: { LATERDOG_THREAD_ID: "thread-1", LATERDOG_COMMS_TOKEN: "two" } }, file);
  expect(JSON.stringify(first.server)).toBe(JSON.stringify(second.server));
  expect(first.server.env).not.toHaveProperty("LATERDOG_COMMS_TOKEN");

  const seen: string[] = [];
  const server = createServer((req, res) => { seen.push(String(req.headers.authorization)); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const client = createHarnessClient(`http://127.0.0.1:${port}`, commsTokenFromEnv(first.server.env as NodeJS.ProcessEnv));
    writeTurnCommsToken(first.token);
    await client.api("/a");
    writeTurnCommsToken(second.token);
    await client.api("/b");
    await client.apiWait!("/c", "{}", 5_000);
  } finally {
    server.close();
  }
  expect(seen).toEqual(["Bearer one", "Bearer two", "Bearer two"]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it("keeps a capability given directly in the environment", () => {
  expect(commsTokenFromEnv({ LATERDOG_COMMS_TOKEN: "direct" })()).toBe("direct");
  expect(commsTokenByFile({ command: "node", env: {} }, "/unused").token).toBeNull();
});
