import { expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createExecutionAdviceRoute } from "./execution-advice.ts";
import { json, readBody } from "../harness/http.ts";
import type { BotRecord } from "../store.ts";
import type { UsageRow } from "../usage-ledger.ts";

it("restricts shared and guest-driven advice to the current thread", async () => {
  let wholeDog = false;
  const asked: string[] = [];
  const current = { instanceId: "fixture", model: "model" };
  const rows: UsageRow[] = ["current", "private", "foreign"].map((threadId) => ({ at: new Date().toISOString(), botId: threadId === "foreign" ? "other-dog" : "dog", botName: "Dog", threadId, instanceId: "fixture", driverKind: "codex", model: "model", input: 10, output: 10, costUsd: null, trigger: { kind: "owner" } }));
  const route = createExecutionAdviceRoute({ active: () => true, wholeDogHistory: () => wholeDog, candidates: async () => [], current: () => current, rows: () => rows, title: (botId, id) => { asked.push(`${botId}:${id}`); return `Inspect ${id}`; } });
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
    const limited = await advise();
    expect(limited.coverage.recordedTurns).toBe(1);
    expect(asked).toEqual(["dog:current"]);
    expect(JSON.stringify(limited)).not.toContain("Inspect current");
    expect(limited).not.toHaveProperty("text");
    wholeDog = true;
    asked.length = 0;
    const whole = await advise();
    expect(whole.coverage.recordedTurns).toBe(2);
    expect(asked.sort()).toEqual(["dog:current", "dog:private"]);
    expect(JSON.stringify(whole)).not.toContain("Inspect private");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
