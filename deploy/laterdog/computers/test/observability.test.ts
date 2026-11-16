import { describe, expect, it } from "vitest";

const fsModule = "node:fs";
const pathModule = "node:path";
const urlModule = "node:url";
const { readFileSync } = await import(fsModule);
const { dirname, join } = await import(pathModule);
const { fileURLToPath } = await import(urlModule);

const HERE: string = dirname(fileURLToPath((import.meta as unknown as { url: string }).url));

describe("what the Worker keeps in its logs", () => {
  it("keeps every console line, and no invocation records, whose request URLs can carry a desktop link's token", () => {
    const config = JSON.parse(readFileSync(join(HERE, "..", "wrangler.jsonc"), "utf8")) as { observability?: Record<string, unknown> };
    expect(config.observability).toEqual({ enabled: true, head_sampling_rate: 1, logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false } });
  });
});
