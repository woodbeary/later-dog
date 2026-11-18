import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoomHandoffs, type RoomHandoffHooks } from "../room-handoffs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { dropContinuation, type ContinuationDrop } from "./dropped-continuation.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("a continuation that never carries on", () => {
  it.each<ContinuationDrop>(["superseded", "cancelled", "failed"])("still wakes the coordinator with its helpers' results, once (%s)", async (why) => {
    const dir = mkdtempSync(join(tmpdir(), "dropped-continuation-"));
    try {
      const hooks: RoomHandoffHooks = { validate: () => undefined, busy: () => false, report: vi.fn(), changed: () => {},
        run: vi.fn(async () => ({ ok: true, text: "done" })) };
      const engine = new RoomHandoffs(join(dir, "requests.json"), hooks);
      const helper = engine.enqueue({ botId: "chief", threadId: "chief-chat" }, "limited-turn", undefined,
        { botId: "scout", threadId: "scout-chat" }, "look", "Look into it").node;
      engine.tick(); await flush(); engine.tick(); await flush();
      expect(helper.status).toBe("completed");
      expect(engine.nodes.get("limited-turn")?.status).toBe("source");
      const log = vi.fn();
      dropContinuation({ settle: (generation, outcome) => engine.sourceSettled(generation, outcome.ok), log }, "chief-chat", "limited-turn", why);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^token battery: chief-chat continuation ${why}; its request tree settles as failed`)));
      engine.tick(); await flush(); engine.tick(); await flush(); engine.tick(); await flush();
      const wakes = vi.mocked(hooks.run).mock.calls.filter(([node, resumed]) => node.id === "limited-turn" && resumed);
      expect(wakes).toHaveLength(1);
      expect(engine.nodes.get("limited-turn")?.status).toBe("completed");
    } finally { await removeTempDir(dir); }
  });
});
