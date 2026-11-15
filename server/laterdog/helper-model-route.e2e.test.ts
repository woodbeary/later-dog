import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";
import { request } from "../../scripts/mcp-server.ts";

it("gives helpers one tier below the dog by default and the dog's own model when 'same' is chosen", async () => {
  const session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.316" });
  try {
    const api = async (path: string, body: unknown, method = "POST") =>
      await request(path, { method, body: JSON.stringify(body) }, session.info.url) as any;
    const cli = async (...args: string[]) => await runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as any;
    const helperModelOf = async (name: string, helperModel?: string) => {
      const bot = (await cli("new-bot", "--name", name)).bot;
      const thread = bot.activeTaskId;
      await api(`/api/bots/${bot.id}/tasks/${thread}`, { modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } }, "PATCH");
      if (helperModel) expect((await api(`/api/bots/${bot.id}`, { helperModel }, "PATCH")).bot.helperModel).toBe(helperModel);
      await cli("send", "--bot", bot.id, "--task", thread, "--text", "hello");
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "40")).status).toBe("settled");
      return JSON.parse(readFileSync(session.fixtureDumpPath, "utf8")).env.CLAUDE_CODE_SUBAGENT_MODEL;
    };
    expect(await helperModelOf("Unset helper dog")).toBe("sonnet");
    expect(await helperModelOf("Same helper dog", "same")).toBeUndefined();
  } finally {
    await session.close();
  }
}, 120_000);
