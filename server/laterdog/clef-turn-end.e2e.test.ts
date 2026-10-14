import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

const KEY = "tsk_clef_turn_end_e2e_91c2d4";

let stub: Server;
let stubUrl = "";
let fixture: VerificationServer;
const answers: string[] = ["stopped_midway", "done"];
const asked: any[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const send = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (body.questions?.answer?.type === "noul") return send({ answers: { answer: { type: "noul", noul: 0.9 } } });
      asked.push(body);
      const options = Object.keys(body.questions.ended.criteria);
      const choice = answers.shift() ?? "done";
      const rest = options.filter((key) => key !== choice);
      send({ model: body.model, answers: { ended: { type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 0.95, ...Object.fromEntries(rest.map((key) => [key, 0.05 / rest.length])) } } } });
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "happy" });
}, 60_000);

afterAll(async () => {
  if (fixture) await waitForExit(fixture.child, { signal: "SIGTERM" }).catch(() => undefined);
  await new Promise<void>((resolve) => stub?.close(() => resolve()));
});

it("nudges a dog that stopped midway once, and lets it be when it is done", async () => {
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  await api("PUT", "/api/config", { decider: { baseUrl: stubUrl, model: "clef-flash" } });
  await api("PUT", "/api/config", { decider: { key: KEY } });
  const bot = (await api("POST", "/api/bots", { name: "Turn end fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Please finish the migration." }, 202);

  const logs = () => {
    const dir = join(dataDir, "clef-log");
    if (!existsSync(dir)) return [] as any[];
    return readdirSync(dir)
      .flatMap((file) => readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)))
      .filter((row) => row.kind === "turnEnd");
  };
  await expect.poll(() => logs().map((row) => row.action), { timeout: 30_000 }).toEqual(["nudged", "left"]);
  expect(logs()[0]).toMatchObject({ choice: "stopped_midway", streak: 1, threadId: bot.threadId });
  expect(logs()[1]).toMatchObject({ choice: "done" });
  expect(asked).toHaveLength(2);
  expect(asked[0].model).toBe("clef-flash");
  expect(asked[0].state.task).toContain("finish the migration");
  expect(JSON.stringify(logs())).not.toContain("migration");
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[];
  expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
}, 90_000);
