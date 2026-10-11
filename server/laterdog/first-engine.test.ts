import { describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "../contracts.ts";
import { firstEngine, hasNoModel } from "./first-engine.ts";

const NONE: ModelSelection = { instanceId: "", model: "" };
const CLAUDE: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

function fixture(bots: { id: string; modelSelection: ModelSelection }[], picks: ModelSelection[]) {
  const assigned: { botId: string; selection: ModelSelection }[] = [];
  const pick = vi.fn(async () => picks.shift() ?? NONE);
  const give = firstEngine({
    bots: () => bots,
    pick,
    assign: (botId, selection) => {
      assigned.push({ botId, selection });
      bots.find((bot) => bot.id === botId)!.modelSelection = selection;
    },
  });
  return { give, pick, assigned };
}

describe("a dog made before any engine was installed", () => {
  it("gets the engine a new dog would get once one shows up, and dogs with a model keep theirs", async () => {
    const codex = { instanceId: "codex", model: "gpt-5" };
    const { give, assigned } = fixture([
      { id: "first", modelSelection: NONE },
      { id: "chosen", modelSelection: codex },
      { id: "second", modelSelection: { ...NONE } },
    ], [CLAUDE]);
    await give();
    expect(assigned).toEqual([{ botId: "first", selection: CLAUDE }, { botId: "second", selection: CLAUDE }]);
  });

  it("waits while there is still no engine, and gets one on a later read", async () => {
    const { give, pick, assigned } = fixture([{ id: "first", modelSelection: NONE }], [NONE, CLAUDE]);
    await give();
    expect(assigned).toEqual([]);
    await give();
    expect(assigned).toEqual([{ botId: "first", selection: CLAUDE }]);
    await give();
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it("reads no engines when every dog has a model", async () => {
    const { give, pick } = fixture([{ id: "chosen", modelSelection: CLAUDE }], [CLAUDE]);
    await give();
    expect(pick).not.toHaveBeenCalled();
  });

  it("runs once at a time, and a failed read is logged, not thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bots = [{ id: "first", modelSelection: NONE }];
    let release!: () => void;
    const pick = vi.fn(() => new Promise<ModelSelection>((_resolve, reject) => {
      release = () => reject(new Error("probe timed out"));
    }));
    const give = firstEngine({ bots: () => bots, pick, assign: vi.fn() });
    const first = give();
    const again = give();
    expect(again).toBe(first);
    release();
    await expect(first).resolves.toBeUndefined();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("probe timed out"));
    warn.mockRestore();
  });

  it("counts only a missing engine as no model", () => {
    expect(hasNoModel({ modelSelection: NONE })).toBe(true);
    expect(hasNoModel({ modelSelection: { instanceId: "codex", model: "" } })).toBe(false);
    expect(hasNoModel({ modelSelection: CLAUDE })).toBe(false);
  });
});
