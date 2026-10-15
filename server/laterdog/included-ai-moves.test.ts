import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";
import { INCLUDED_AI_INSTANCE, INCLUDED_GROK_INSTANCE } from "./included-ai.ts";
import { moveRetiredIncludedModels } from "./included-ai-moves.ts";

const boot = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("moving saved dogs off the retired free models", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("saves the move, so a restart finds every dog and thread on the current free models", () => {
    const store = new Store(boot);
    const kimiDog = store.createBot({ name: "Biscuit", modelSelection: { instanceId: INCLUDED_AI_INSTANCE, model: "kimi-k2.6" } });
    store.patchBot(kimiDog.id, { fallback: [{ instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.3" }] });
    const thread = store.createTask(kimiDog.id, "Old Grok thread", false, undefined, undefined, undefined, { instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.3" });
    const ownDog = store.createBot({ name: "Pepper", modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } });

    expect(moveRetiredIncludedModels(store)).toBe(2);

    const reopened = new Store(boot);
    expect(reopened.bot(kimiDog.id)?.modelSelection).toEqual({ instanceId: INCLUDED_AI_INSTANCE, model: "claude-sonnet-5" });
    expect(reopened.bot(kimiDog.id)?.fallback).toEqual([{ instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.7" }]);
    expect(reopened.taskByThread(kimiDog.id, thread!.threadId)?.modelSelection).toEqual({ instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.7" });
    expect(reopened.bot(ownDog.id)?.modelSelection).toEqual({ instanceId: "claude", model: "claude-opus-5-5" });
    expect(moveRetiredIncludedModels(reopened)).toBe(0);
  });
});
