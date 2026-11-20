import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { SecureFormDesk } from "./secure-form.ts";

const KEY = `ldc_${"r".repeat(48)}`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");
const BOX = "cmp_routing1";
let server: Server;
let keyDir = "";
let tools: typeof import("../cloud-computer-tools.ts");
const commands: string[] = [];

const desk: SecureFormDesk = {
  open: () => ({ error: "unused" }),
  field: () => ({ ok: true, host: "login.example.test", label: "Password", value: "S3cret-pass!" }),
  typed: () => ({ last: true }),
  result: () => ({ ok: true, text: "unused" }),
};

const rpc = (name: string, args: Record<string, unknown>) => tools.cloudComputerRpc({ method: "tools/call", params: { name, arguments: args } }, {
  cfg: {} as AppConfig, boxId: () => BOX, signal: new AbortController().signal,
  gate: async () => ({ held: false }), assertActive: () => {}, secureForms: desk,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { code: "unauthorized", message: "unknown key" } });
      if (req.method === "POST" && req.url === `/v1/computers/${BOX}/exec`) {
        const command = String(JSON.parse(body).command);
        commands.push(command);
        return send(200, { exitCode: 0, stdout: command.includes("base64 -w0") ? JPEG : "", stderr: "" });
      }
      send(404, { error: { code: "not_found", message: "not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  keyDir = mkdtempSync(join(tmpdir(), "laterdog-routing-key-"));
  writeFileSync(join(keyDir, "computers-key"), KEY);
  vi.stubEnv("LATERDOG_COMPUTERS_API", `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
  vi.stubEnv("LATERDOG_COMPUTERS_KEY_FILE", join(keyDir, "computers-key"));
  vi.resetModules();
  tools = await import("../cloud-computer-tools.ts");
});

beforeEach(() => { commands.length = 0; });

afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(keyDir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a computer the computers service runs, reached the way a dog reaches it", () => {
  it("gets the capped screenshot in one command", async () => {
    const shot = await rpc("screenshot", {});
    expect(shot).toEqual({ content: [{ type: "image", mimeType: "image/jpeg", data: JPEG }] });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--thumb");
    expect(commands[0]).toContain("102400");
  });

  it("gets clicks and a Secure Form's fill in screenshot coordinates", async () => {
    await rpc("click", { x: 512, y: 320 });
    expect(commands[0]).toContain("102400");
    expect(commands[0]).toContain("TX=$(( 512 * 100 / P ))");
    commands.length = 0;
    await rpc("fill_secure_field", { form_id: "f1", field_id: "password", x: 512, y: 320 });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("102400");
    expect(commands[0]).toContain("SX=$(( 512 * 100 / P ))");
  });
});
