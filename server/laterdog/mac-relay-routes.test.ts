import { describe, expect, it } from "vitest";
import { MacRelayQueue } from "./mac-relay.ts";
import { macRelayRoutes } from "./mac-relay-routes.ts";

const authenticate = (bearer: string | undefined) => (bearer === "good-token" ? { botId: "bot-1" } : null);

describe("macRelayRoutes", () => {
  it("refuses an unknown bearer on every route", async () => {
    const routes = macRelayRoutes(new MacRelayQueue(), authenticate);
    expect((await routes.nextJob("bad")).status).toBe(401);
    expect((await routes.completeJob("bad", "job-1", { text: "x" })).status).toBe(401);
    expect((await routes.failJob("bad", "job-1", { message: "x" })).status).toBe(401);
  });

  it("hands the Mac its bot's next job and nothing when the queue is empty", async () => {
    const queue = new MacRelayQueue();
    const routes = macRelayRoutes(queue, authenticate);
    expect((await routes.nextJob("good-token")).body).toEqual({ job: null });
    const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug");
    turn.catch(() => {});
    const polled = await routes.nextJob("good-token");
    expect((polled.body as { job: { text: string } }).job.text).toBe("fix the bug");
  });

  it("rejects a result with no text and completes a real job", async () => {
    const queue = new MacRelayQueue();
    const routes = macRelayRoutes(queue, authenticate);
    const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug");
    const job = queue.nextJob("bot-1")!;
    expect((await routes.completeJob("good-token", job.id, {})).status).toBe(400);
    const result = await routes.completeJob("good-token", job.id, { text: "fixed it" });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    await expect(turn).resolves.toBe("fixed it");
  });

  it("reports 404 for a job id that was never leased", async () => {
    const routes = macRelayRoutes(new MacRelayQueue(), authenticate);
    expect((await routes.completeJob("good-token", "missing", { text: "x" })).status).toBe(404);
    expect((await routes.failJob("good-token", "missing", { message: "x" })).status).toBe(404);
  });

  it("fails a job with a plain message", async () => {
    const queue = new MacRelayQueue();
    const routes = macRelayRoutes(queue, authenticate);
    const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug");
    const job = queue.nextJob("bot-1")!;
    const result = await routes.failJob("good-token", job.id, { message: "local engine crashed" });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    await expect(turn).rejects.toThrow("local engine crashed");
  });
});
