import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog, type VerificationServer } from "../scripts/control-laterdog.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("spend cap inside a team goal run", () => {
  let session: VerificationServer;
  let layerDir: string;

  beforeEach(async () => {
    layerDir = mkdtempSync(join(tmpdir(), "laterdog-fake-layer-goal-"));
    mkdirSync(join(layerDir, "server"));
    writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Co", features: ["budgets", "billing"], expiresAt: "2099-01-01" }; }\n');
    session = await launchVerificationServer({
      ...process.env,
      FAKE_CLAUDE_REPLIES: JSON.stringify([
        'The plan is ready.\n<laterdog-goal>{"status":"continue","next":"Worker","instruction":"Do the thing","detail":"Plan ready"}</laterdog-goal>',
      ]),
    }, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
  }, 60_000);

  afterEach(async () => {
    console.info(JSON.stringify(session.info));
    await session.close();
    await removeTempDir(layerDir);
  });

  const control = (args: string[]) => runControlLaterDog([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, init: RequestInit = {}) => fetch(`${session.info.url}${path}`, init);
  const put = (body: unknown) => api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("ends a capped goal as a blocked run with the cap detail, without retrying the refusal", async () => {
    expect((await (await api("/api/edition")).json())).toMatchObject({ edition: "enterprise", features: ["billing", "budgets"] });

    expect((await put({
      budgets: { monthlyUsd: 0.01, warnAtPercent: 50 },
      billing: { currency: "USD", prices: { default: { inputPerMillion: 1000, outputPerMillion: 2000 } } },
    })).status).toBe(200);

    const lead = (await control(["new-bot", "--name", "Lead"])) as { bot: { id: string } };
    const worker = (await control(["new-bot", "--name", "Worker"])) as { bot: { id: string } };

    const roomRes = await api("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Capped goal room",
        memberIds: [lead.bot.id, worker.bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.bot.id } },
      }),
    });
    expect(roomRes.status).toBe(201);
    const room = (await roomRes.json()) as { group: { id: string; threadId: string } };

    const sent = await api(`/api/groups/${encodeURIComponent(room.group.id)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ship the plan", mode: "goal" }),
    });
    expect(sent.status).toBe(202);

    await control(["wait", "--channel", room.group.id, "--timeout", "30"]);

    const page = (await (await api(`/api/threads/${encodeURIComponent(room.group.threadId)}/messages?limit=50`)).json()) as any;
    const goalCard = page.messages.find((m: any) => m.role === "bot" && m.kind === "goal.run");
    expect(goalCard).toBeTruthy();
    expect(goalCard.goalRun.status).toBe("blocked");
    expect(goalCard.goalRun.detail).toContain("monthly spend limit");

    const capMessages = page.messages.filter(
      (m: any) => m.role === "bot" && m.kind === "activity" && /reached its monthly spend limit/i.test(m.tool?.name ?? ""),
    );
    expect(capMessages).toHaveLength(1);

    expect(page.messages.some((m: any) => /retrying once/i.test(m.tool?.name ?? ""))).toBe(false);

    await expect.poll(async () => (await (await api("/api/usage")).json() as any).total.turns,
      { timeout: 10_000 }).toBe(1);
    const usage = (await (await api("/api/usage")).json()) as any;
    expect(usage.budget).toMatchObject({ monthlyUsd: 0.01, exceeded: true, warn: true });
    expect(usage.total.turns).toBe(1);
  }, 150_000);
});
