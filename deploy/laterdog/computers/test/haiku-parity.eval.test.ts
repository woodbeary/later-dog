import { describe, expect, it } from "vitest";
import { liveProviders, parityTable, parityTurns, runParity } from "./haiku-parity";

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const live = env.HAIKU_PARITY === "1";

describe.runIf(live)("Claude Haiku against Kimi on recorded later.dog turns, live", () => {
  it("matches or beats Kimi on every turn", async () => {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
    const token = env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
    if (!accountId || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI and AI Gateway run access).");
    const providers = liveProviders({ accountId, token, gatewayId: env.AI_GATEWAY_ID?.trim() || "default", kimiModel: env.TRIAL_AI_WORKERS_MODEL?.trim(), haikuModel: env.TRIAL_AI_ANTHROPIC_MODEL?.trim() });
    const runs = Math.max(1, Number.parseInt(env.HAIKU_PARITY_RUNS ?? "3", 10) || 3);
    const report = await runParity(providers, await parityTurns(), runs);
    console.log(parityTable(report));
    const out = env.HAIKU_PARITY_REPORT?.trim();
    if (out) {
      const fsModule = "node:fs/promises";
      const { writeFile } = await import(fsModule);
      await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    expect(report.invalid).toEqual([]);
    expect(report.worse).toEqual([]);
  }, 600_000);
});
