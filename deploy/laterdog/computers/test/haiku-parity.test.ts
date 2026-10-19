import { describe, expect, it, vi } from "vitest";
import { AI_WORKERS_MODEL } from "../src/ai";
import { AI_ANTHROPIC_MODEL } from "../src/anthropic";
import { TOOLS } from "../src/mcp-tools";
import { COMPUTER_ID, GREEN_BUTTON, KIMI_LIST_CALL, SCREEN, buttonsScreenshot, liveProviders, parityTable, parityTurns, runParity } from "./haiku-parity";

const CLAUDE_ID = /^[A-Za-z0-9_-]+$/;

type Block = { type: string; id?: string; tool_use_id?: string };

function claudeIds(messages: { content: Block[] }[]) {
  const blocks = messages.flatMap((message) => message.content);
  return { uses: blocks.filter((block) => block.type === "tool_use").map((block) => block.id!), results: blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id!) };
}

type Call = { name: string; args: Record<string, unknown> } | { text: string };

function rightReply(body: string): Call {
  if (body.includes("\"image\"") || body.includes("image_url")) return { name: "computer_action", args: { computer_id: COMPUTER_ID, action: "click", x: (GREEN_BUTTON.left + GREEN_BUTTON.right) / 2, y: (GREEN_BUTTON.top + GREEN_BUTTON.bottom) / 2 } };
  if (body.includes("26%")) return { text: "The disk is 26% full." };
  if (body.includes("sleeping")) return { name: "computer_wake", args: { computer_id: COMPUTER_ID } };
  if (body.includes("uname")) return { name: "computer_exec", args: { computer_id: COMPUTER_ID, command: "uname -a" } };
  if (body.includes("Which cloud computers")) return { name: "computer_list", args: {} };
  return { text: "391" };
}

function upstream(haikuMisses: string | null = null) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const messages = (JSON.parse(String(init.body)) as { messages: { content: Block[] }[] }).messages;
    const body = JSON.stringify(messages);
    if (url.includes("/anthropic/v1/messages")) {
      const ids = claudeIds(messages);
      if (![...ids.uses, ...ids.results].every((id) => CLAUDE_ID.test(id))) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "tool_use.id: String should match pattern" } }, { status: 400 });
    }
    const reply = haikuMisses !== null && url.includes("anthropic") && body.includes(haikuMisses) ? { text: "I can't do that." } : rightReply(body);
    if (url.includes("/anthropic/v1/messages")) {
      const content = "text" in reply ? [{ type: "text", text: reply.text }] : [{ type: "tool_use", id: "toolu_1", name: reply.name, input: reply.args }];
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: AI_ANTHROPIC_MODEL, content, stop_reason: "text" in reply ? "end_turn" : "tool_use", usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 } });
    }
    const message = "text" in reply ? { role: "assistant", content: reply.text } : { role: "assistant", content: null, tool_calls: [{ id: `functions.${reply.name}:0`, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] };
    return Response.json({ result: { id: "k", object: "chat.completion", model: AI_WORKERS_MODEL, choices: [{ index: 0, message }], usage: { total_tokens: 200 } }, success: true });
  });
}

const SETTINGS = { accountId: "acct-test", token: "token-for-tests", gatewayId: "laterdog" };

describe("the Haiku and Kimi parity eval", () => {
  it("draws a real PNG with the green button where the click turn expects it", async () => {
    const url = await buttonsScreenshot();
    const bytes = Uint8Array.from(atob(url.slice("data:image/png;base64,".length)), (char) => char.charCodeAt(0));
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([SCREEN.width, SCREEN.height]);
    const idatLength = view.getUint32(33);
    expect(new TextDecoder().decode(bytes.subarray(37, 41))).toBe("IDAT");
    const raw = new Uint8Array(await new Response(new Blob([bytes.subarray(41, 41 + idatLength)]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
    const pixel = (x: number, y: number) => [...raw.subarray(y * (1 + SCREEN.width * 3) + 1 + x * 3, y * (1 + SCREEN.width * 3) + 4 + x * 3)];
    expect(pixel(300, 230)).toEqual([40, 170, 60]);
    expect(pixel(100, 230)).toEqual([220, 40, 40]);
  });

  it("sends each recorded turn to Kimi on Workers AI and to Claude through the gateway, and reports parity", async () => {
    const fetcher = upstream();
    const turns = await parityTurns();
    const report = await runParity(liveProviders(SETTINGS, fetcher), turns, 2);
    expect(report.parity).toBe(true);
    expect(report.invalid).toEqual([]);
    expect(report.totals.kimi).toMatchObject({ passed: 12, runs: 12, tokens: 2_400 });
    expect(report.totals.haiku).toMatchObject({ passed: 12, runs: 12, tokens: 1_920 });
    expect(new Set(report.turns.map((turn) => turn.kind))).toEqual(new Set(["chat", "tool", "computer"]));
    const [kimiUrl, kimiInit] = fetcher.mock.calls[0]!;
    expect(kimiUrl).toBe(`https://api.cloudflare.com/client/v4/accounts/acct-test/ai/run/${AI_WORKERS_MODEL}`);
    expect(kimiInit.headers).toMatchObject({ authorization: "Bearer token-for-tests" });
    expect(JSON.parse(String(kimiInit.body))).toMatchObject({ stream: false, chat_template_kwargs: { thinking: false } });
    const [haikuUrl, haikuInit] = fetcher.mock.calls[1]!;
    expect(haikuUrl).toBe("https://gateway.ai.cloudflare.com/v1/acct-test/laterdog/anthropic/v1/messages");
    expect(haikuInit.headers).toMatchObject({ "cf-aig-authorization": "Bearer token-for-tests", "anthropic-version": "2023-06-01" });
    expect(haikuInit.headers).not.toHaveProperty("x-api-key");
    const sent = JSON.parse(String(haikuInit.body));
    expect(sent).toMatchObject({ model: AI_ANTHROPIC_MODEL, thinking: { type: "disabled" }, tool_choice: { type: "auto" } });
    expect(sent.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(parityTable(report)).toContain("parity: Claude matches or beats Kimi on every turn");
    const kimiHistory = fetcher.mock.calls.filter(([url, init]) => url.includes("anthropic") && String(init.body).includes("Take a screenshot of my computer.")).map(([, init]) => claudeIds(JSON.parse(String(init.body)).messages));
    expect(kimiHistory.length).toBeGreaterThan(0);
    for (const ids of kimiHistory) {
      expect(ids.uses).toHaveLength(1);
      expect(ids.results).toEqual(ids.uses);
      expect(ids.uses[0]).toMatch(CLAUDE_ID);
      expect(ids.uses[0]).not.toBe(KIMI_LIST_CALL);
    }
  });

  it("names the turns where Claude does worse than Kimi and counts a failed call as a miss", async () => {
    const report = await runParity(liveProviders(SETTINGS, upstream("uname")), await parityTurns(), 1);
    expect(report.parity).toBe(false);
    expect(report.worse).toEqual(["fills a command's arguments"]);
    expect(report.turns.find((turn) => turn.name === "fills a command's arguments")!.scores.haiku.replies).toEqual(["text: I can't do that."]);
    expect(parityTable(report)).toContain("parity: NO, Claude is worse on: fills a command's arguments");
    const down = vi.fn(async (url: string) => (url.includes("anthropic") ? new Response("{\"error\":\"no key\"}", { status: 401 }) : upstream()(url, { body: JSON.stringify({ messages: [{ role: "user", content: "17 times 23" }] }) })));
    const failed = await runParity(liveProviders(SETTINGS, down), (await parityTurns()).slice(0, 1), 1);
    expect(failed.parity).toBe(false);
    expect(failed.invalid).toEqual(["haiku gave no answer on 1 of 1 runs"]);
    expect(failed.turns[0]!.scores.haiku.replies).toEqual(["no answer"]);
  });

  it("calls the eval invalid, not parity, when both providers fail every run", async () => {
    const down = vi.fn(async (url: string) => new Response("{\"error\":\"down\"}", { status: url.includes("anthropic") ? 401 : 500 }));
    const report = await runParity(liveProviders(SETTINGS, down), await parityTurns(), 2);
    expect(report.worse).toEqual([]);
    expect(report.parity).toBe(false);
    expect(report.invalid).toEqual(["kimi gave no answer on 12 of 12 runs", "haiku gave no answer on 12 of 12 runs"]);
    const table = parityTable(report);
    expect(table).toContain("eval invalid, not a parity result");
    expect(table).not.toContain("parity: Claude matches");
  });

  it("calls the eval invalid when both answer but neither passes, or Kimi passes under half its runs", async () => {
    const wrong = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("anthropic")) return Response.json({ id: "m", type: "message", role: "assistant", model: AI_ANTHROPIC_MODEL, content: [{ type: "text", text: "no idea" }], stop_reason: "end_turn", usage: {} });
      return Response.json({ result: { choices: [{ index: 0, message: { role: "assistant", content: String(init.body).includes("17 times 23") ? "391" : "no idea" } }] } });
    });
    const report = await runParity(liveProviders(SETTINGS, wrong), await parityTurns(), 1);
    expect(report.parity).toBe(false);
    expect(report.invalid).toEqual(["haiku passed none of its 6 runs", "kimi passed only 1 of 6 runs, below the 50% floor, so the turns or the request shape are suspect"]);
  });
});
