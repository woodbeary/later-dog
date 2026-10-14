import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, siteverify, startTrial, trialKey, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const RUNS = 200;
const OVERHEAD_P50_BUDGET_MS = 25;
const percentile = (samples: number[], p: number) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * p))]!;

describe("what the Worker adds around the model", () => {
  it("is a few milliseconds at the median with a model that answers at once", async () => {
    const run = vi.fn(async () => ({ response: " the failing tests" }));
    const w = await world({ AI: { run, gateway: vi.fn() } } as unknown as Record<string, string>);
    siteverify();
    const key = trialKey("k");
    expect((await startTrial(w, key)).status).toBe(200);
    const payload = { prefix: "Please fix", dog: "Rex", messages: [{ role: "dog", text: "Two tests fail." }, { role: "person", text: "ok thanks" }], phrasing: ["Can you check"] };
    const samples: number[] = [];
    for (let index = 0; index < RUNS + 10; index += 1) {
      const started = performance.now();
      const response = await w.fetch(apiRequest("POST", "/v1/complete", key, { body: { ...payload, prefix: `${payload.prefix} ${index}` } }));
      const took = performance.now() - started;
      expect(response.status).toBe(200);
      if (index >= 10) samples.push(took);
    }
    const report = {
      runs: RUNS,
      p50Ms: Math.round(percentile(samples, 0.5) * 100) / 100,
      p95Ms: Math.round(percentile(samples, 0.95) * 100) / 100,
      maxMs: Math.round(Math.max(...samples) * 100) / 100,
    };
    expect(report.p50Ms).toBeLessThan(OVERHEAD_P50_BUDGET_MS);
  });
});
