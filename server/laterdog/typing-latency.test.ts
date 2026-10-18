import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createTypingSuggestionsRoutes } from "../routes/typing-suggestions.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createTypingService } from "./typing-suggestions.ts";

const KEY = `ldt_${"d".repeat(43)}`;
const RUNS = 120;
const BACKEND_DELAYS_MS = [0, 120] as const;
const SERVER_OVERHEAD_P50_MS = 30;
const END_TO_END_P50_MS = 300;

const percentile = (samples: number[], p: number) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * p))]!;

let home: string;
let before: string | undefined;
let server: Server;
let base: string;
let delay = 0;

const fakeBackend = (async (_url: string, init: RequestInit) => {
  const sent = JSON.parse(String(init.body));
  await new Promise((resolve) => setTimeout(resolve, delay));
  return new Response(JSON.stringify({ completion: ` and then ${String(sent.prefix).length} more words`, model: "fake" }), { headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

beforeAll(async () => {
  before = process.env.LATERDOG_HOME;
  home = mkdtempSync(join(tmpdir(), "ld-typing-latency-"));
  process.env.LATERDOG_HOME = home;
  writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true, included: ["decisions", "voice", "ai"] }));
  writeFileSync(join(home, "computers-trial-key"), `${KEY}\n`);
  const typing = createTypingService({ config: () => ({ features: { typingSuggestions: true, smarterSuggestions: true } }) as AppConfig, fetch: fakeBackend });
  const routes = [createTypingSuggestionsRoutes({ typing, rankingReady: () => false, rank: async () => ({ ok: false, reason: "unavailable" }) })];
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  if (before === undefined) delete process.env.LATERDOG_HOME;
  else process.env.LATERDOG_HOME = before;
  rmSync(home, { recursive: true, force: true });
});

async function measure(backendDelay: number): Promise<number[]> {
  delay = backendDelay;
  const samples: number[] = [];
  for (let index = 0; index < RUNS + 10; index += 1) {
    const started = performance.now();
    const res = await fetch(`${base}/api/typing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix: `Could you please look into number ${backendDelay}-${index}`, dog: "Rex", messages: [{ role: "dog", text: "Two tests fail." }, { role: "person", text: "ok thanks" }], phrasing: ["Can you check"] }),
    });
    const body = (await res.json()) as { completion: string };
    const took = performance.now() - started;
    expect(body.completion).toContain("more words");
    if (index >= 10) samples.push(took);
  }
  return samples;
}

describe("how long the model path takes through this app's server, with a fake backend", () => {
  it("adds little of its own, and stays under 300 ms at the median when the backend takes 120 ms", async () => {
    const report: Record<string, { p50: number; p95: number; max: number }> = {};
    for (const backendDelay of BACKEND_DELAYS_MS) {
      const samples = await measure(backendDelay);
      report[`backend ${backendDelay} ms`] = { p50: Math.round(percentile(samples, 0.5) * 10) / 10, p95: Math.round(percentile(samples, 0.95) * 10) / 10, max: Math.round(Math.max(...samples) * 10) / 10 };
    }
    if (process.env.TYPING_BENCH_OUT) writeFileSync(process.env.TYPING_BENCH_OUT, JSON.stringify({ runs: RUNS, serverModelPath: report }, null, 2));
    expect(report["backend 0 ms"]!.p50 - 0).toBeLessThan(SERVER_OVERHEAD_P50_MS);
    expect(report["backend 120 ms"]!.p50).toBeLessThan(END_TO_END_P50_MS);
  });
});
