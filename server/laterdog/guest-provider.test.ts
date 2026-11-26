import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { GrokDriver } from "../drivers/grok.ts";
import { recordEvents } from "../testing/events.ts";
import { remoteEngineChoice, setEngineOpener } from "./engine-placement.ts";
import { commandLink } from "./engine-remote.ts";
import { placeProvider } from "./guest-provider.ts";

const here = dirname(fileURLToPath(import.meta.url));
afterEach(() => { vi.unstubAllEnvs(); setEngineOpener(null); });

it("runs a managed API chat and its writing task through the dog computer and refuses a failed wake", async () => {
  vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ld-api-")));
  const remote = join(root, "box");
  mkdirSync(remote);
  writeFileSync(join(root, "remote-engines.json"), JSON.stringify({ placement: "computer", homeBots: ["dog"] }));
  expect(remoteEngineChoice(root, "dog")).toMatchObject({ computer: true, required: true });
  const calls: string[] = [];
  const api = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const json = JSON.parse(Buffer.concat(parts).toString());
    calls.push(String(req.headers.authorization));
    const message = { content: "from the provider" };
    if (!json.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 8, completion_tokens: 3 } }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.end('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const port = (api.address() as { port: number }).port;
  const input = { instanceId: "grok-test", displayName: "Fixture", enabled: true, config: GrokDriver.decodeConfig({ url: "http://127.0.0.1:" + port, tools: false }), environment: { XAI_API_KEY: "fixture-access", UNRELATED_TOKEN: "home-only" } };
  const local = await GrokDriver.create(input);
  const localTurn = vi.spyOn(local.adapter, "sendTurn");
  const localText = vi.spyOn(local, "generateText");
  const placed = placeProvider(local, input, root);
  const events = recordEvents(placed.adapter);
  const opened: string[] = [];
  let available = true;
  setEngineOpener({
    remoteBase: join(root, "run"), proxyPath: join(here, "engine-proxy.ts"),
    guestProvider: { entry: join(here, "provider-guest.ts"), proxy: join(here, "engine-proxy.ts") },
    async open(bot, plan) {
      opened.push(bot);
      if (!available) throw new Error("fixture computer asleep");
      expect(JSON.stringify(plan.launch)).not.toContain("home-only");
      plan.launch.cli = process.execPath;
      plan.launch.env.HOME = remote;
      plan.launch.env.LATERDOG_HOME = remote;
      return commandLink(process.execPath, [join(here, "engine-relay.ts")], { ...process.env, LATERDOG_ENGINE_TEST_ROOT: remote });
    },
  });
  try {
    const turn = { botId: "dog", threadId: "thread", sourceMessageId: "message", text: "hello", guestConfined: true };
    const result = await placed.adapter.sendTurn(turn);
    await expect(events.until(event => event.type === "turn.completed")).resolves.toMatchObject({ ok: true, turnId: result.turnId });
    expect(events.events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "from the provider" }));
    await expect(placed.generateText!("title", { botId: "dog" })).resolves.toBe("from the provider");
    available = false;
    await expect(placed.adapter.sendTurn({ ...turn, threadId: "failure" })).rejects.toThrow();
    expect(opened).toEqual(["dog", "dog", "dog"]);
    expect(calls).toEqual(["Bearer fixture-access", "Bearer fixture-access"]);
    expect(localTurn).not.toHaveBeenCalled();
    expect(localText).not.toHaveBeenCalled();
  } finally {
    events.stop();
    await placed.dispose();
    api.closeAllConnections();
    await new Promise<void>(resolve => api.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
