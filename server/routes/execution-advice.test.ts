import { expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createExecutionAdviceRoute } from "./execution-advice.ts";
import { json, readBody } from "../harness/http.ts";
import type { BotRecord } from "../store.ts";
import type { UsageRow } from "../usage-ledger.ts";

it("restricts shared and guest-driven advice to the current thread", async () => {
  let wholeDog = false;
  const current = { instanceId: "fixture", model: "model" };
  const rows: UsageRow[] = ["current", "private"].map((threadId) => ({ at: new Date().toISOString(), botId: "dog", botName: "Dog", threadId, instanceId: "fixture", driverKind: "codex", model: "model", input: 10, output: 10, costUsd: null, trigger: { kind: "owner" } }));
  const route = createExecutionAdviceRoute({ active: () => true, wholeDogHistory: () => wholeDog, candidates: async () => [], current: () => current, rows: () => rows });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    void route({ req, res, url, path: url.pathname, method: req.method!, json, sender: { id: "dog" } as BotRecord, threadId: "current", capability: {}, readBody: () => readBody(req) });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/execution-advice`;
  try {
    const advise = async () => {
      const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "inspect" }) });
      return result.json() as Promise<{ coverage: { recordedTurns: number } }>;
    };
    expect((await advise()).coverage.recordedTurns).toBe(1);
    wholeDog = true;
    expect((await advise()).coverage.recordedTurns).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
