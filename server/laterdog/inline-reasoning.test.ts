import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { INCLUDED_AI_INSTANCE, INCLUDED_GROK_INSTANCE, IncludedAiDriver, IncludedGrokDriver } from "./included-ai.ts";
import { inlineReasoning, reasonsInContent, replyWithoutReasoning, type ReplyStream } from "./inline-reasoning.ts";

const HELLO_TRACE = [
  "The", " user", " wants", " me to reply with exactly three words: \"hello from cloud\".", " That's straightforward.", "</", "think>", "hello", " from", " cloud",
];
const HELLO_REASONING = "The user wants me to reply with exactly three words: \"hello from cloud\". That's straightforward.";
const PS_OUTPUT = "```\n  PID  PPID COMMAND\n    1     0 /sbin/launchd\n```";
const PS_TRACE = [
  "The user wants me to run a shell command and reply with ONLY its raw output", "...", " Let me extract just the stdout from the result.", "</think>", "```\n  PID  PPID COMMAND\n", "    1     0 /sbin/launchd\n```",
];

function split(chunks: string[], expected = true, before?: (stream: ReturnType<typeof inlineReasoning>) => void) {
  const parts: Array<[ReplyStream, string]> = [];
  const stream = inlineReasoning(expected, (text, kind) => parts.push([kind, text]));
  before?.(stream);
  const beforeEnd: Array<[ReplyStream, string]>[] = [];
  for (const chunk of chunks) {
    stream.content(chunk);
    beforeEnd.push([...parts]);
  }
  const streamed = [...parts];
  stream.end();
  const joined = (kind: ReplyStream, from = parts) => from.filter(([k]) => k === kind).map(([, text]) => text).join("");
  return {
    reply: joined("assistant_text"),
    reasoning: joined("reasoning_text"),
    streamedReply: joined("assistant_text", streamed),
    streamedReasoning: joined("reasoning_text", streamed),
    afterChunk: (index: number) => ({ reply: joined("assistant_text", beforeEnd[index]), reasoning: joined("reasoning_text", beforeEnd[index]) }),
  };
}

const byCharacter = (chunks: string[]) => [...chunks.join("")];

describe("reasoning a model writes into its reply", () => {
  it("knows which models do it by their id", () => {
    for (const model of ["kimi-k2.6", "@cf/moonshotai/kimi-k2.6", "moonshotai/Kimi-K2-Thinking", "deepseek-r1-distill-llama-70b", "DeepSeek-R1", "qwq-32b"]) {
      expect(reasonsInContent(model), model).toBe(true);
    }
    for (const model of ["grok-4.3", "MiniMax-M3", "gpt-4o", "deepseek-chat", "qwen3-coder", undefined, 7]) {
      expect(reasonsInContent(model), String(model)).toBe(false);
    }
  });

  it.each([
    ["as recorded", HELLO_TRACE],
    ["one character at a time", byCharacter(HELLO_TRACE)],
  ])("moves an unopened block before </think> into the reasoning stream (%s)", (_name, chunks) => {
    const result = split(chunks);
    expect(result.reply).toBe("hello from cloud");
    expect(result.reasoning).toBe(HELLO_REASONING);
    expect(result.streamedReply).toBe("hello from cloud");
    expect(result.reply).not.toContain("think>");
  });

  it("never shows the reasoning as reply text while it streams", () => {
    const result = split(HELLO_TRACE);
    const closing = HELLO_TRACE.indexOf("</");
    for (let index = 0; index <= closing; index++) expect(result.afterChunk(index).reply).toBe("");
    expect(result.afterChunk(closing - 1).reasoning).toBe(HELLO_REASONING);
    expect(result.afterChunk(closing + 2).reply).toBe("hello");
  });

  it.each([
    ["as recorded", PS_TRACE],
    ["one character at a time", byCharacter(PS_TRACE)],
  ])("keeps a code block reply that follows the reasoning (%s)", (_name, chunks) => {
    const result = split(chunks);
    expect(result.reply).toBe(PS_OUTPUT);
    expect(result.reasoning).toBe("The user wants me to run a shell command and reply with ONLY its raw output... Let me extract just the stdout from the result.");
  });

  it.each([
    ["as recorded", ["<th", "ink>\nuser said hi\n</th", "ink>\n\nHello!", " How can I help?"]],
    ["one character at a time", [..."<think>\nuser said hi\n</think>\n\nHello! How can I help?"]],
    ["after leading blank lines", ["\n\n", "<think>", "user said hi", "</think>", "Hello! How can I help?"]],
  ])("takes out a block with both tags (%s)", (_name, chunks) => {
    const result = split(chunks);
    expect(result.reply).toBe("Hello! How can I help?");
    expect(result.reasoning.trim()).toBe("user said hi");
  });

  it("takes out an empty block and a lone closing tag", () => {
    expect(split(["<think>\n\n</think>\n\n", "Hi"]).reply).toBe("Hi");
    expect(split(["</think>", "Hi"]).reply).toBe("Hi");
    expect(split(["</think>", "Hi"]).reasoning).toBe("");
  });

  it("keeps a plain reply whole when no </think> ever comes", () => {
    const result = split(["Hello", " there.", " The weather is fine."]);
    expect(result.reply).toBe("Hello there. The weather is fine.");
    expect(result.streamedReasoning).toBe("Hello there. The weather is fine.");
  });

  it.each([
    ["a code block", ["```", "bash\nls\n```"], "```bash\nls\n```"],
    ["JSON", ["{\"ok\"", ": true}"], "{\"ok\": true}"],
    ["a heading", ["# Plan", "\n- one"], "# Plan\n- one"],
    ["a table", ["| a | b |"], "| a | b |"],
    ["a tool call written as text", ["<|tool_calls_section_begin|>"], "<|tool_calls_section_begin|>"],
  ])("streams a reply that clearly is not reasoning straight away: %s", (_name, chunks, reply) => {
    const result = split(chunks);
    expect(result.streamedReply).toBe(reply);
    expect(result.reasoning).toBe("");
  });

  it("passes content straight through when the provider sends reasoning on its own", () => {
    const result = split(["Hello", " there"], true, (stream) => stream.reasoningApart());
    expect(result.afterChunk(0).reply).toBe("Hello");
    expect(result.reply).toBe("Hello there");
  });

  it("leaves other models' text alone, unless the answer came from one that does it", () => {
    expect(split(["<think>\nkeep\n</think>Hello!"], false).reply).toBe("<think>\nkeep\n</think>Hello!");
    expect(split(HELLO_TRACE, false, (stream) => stream.answeredBy("@cf/moonshotai/kimi-k2.6")).reply).toBe("hello from cloud");
    expect(split(HELLO_TRACE, false, (stream) => stream.answeredBy("grok-4-1-fast-reasoning")).reply).toBe(`${HELLO_REASONING}</think>hello from cloud`);
  });

  it("treats an unclosed opened block as reasoning, and keeps stray partial tags as text", () => {
    const unclosed = split(["<think>", "still thinking about it</thi"]);
    expect(unclosed.reply).toBe("");
    expect(unclosed.reasoning).toBe("still thinking about it</thi");
    expect(split(["  ", "<th"]).reply).toBe("  <th");
    expect(split(["<b>bold</b>"]).streamedReply).toBe("<b>bold</b>");
  });

  it("cleans a whole message the same way", () => {
    expect(replyWithoutReasoning(HELLO_TRACE.join(""), true)).toBe("hello from cloud");
    expect(replyWithoutReasoning("Just a title", true)).toBe("Just a title");
    expect(replyWithoutReasoning("<think>x</think>Title", false)).toBe("<think>x</think>Title");
  });
});

const KEY = `ldt_${"c".repeat(43)}`;
const WORKERS_MODEL = "@cf/moonshotai/kimi-k2.6";
const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
  ({ id: "c1", object: "chat.completion.chunk", created: 1, model: WORKERS_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
const usageFrame = { id: "c1", object: "chat.completion.chunk", created: 1, model: WORKERS_MODEL, choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } };
const recorded = (contents: string[], finish = "stop") => [
  frame({ role: "assistant", content: "" }),
  ...contents.map((content, index) => frame({ content }, index === contents.length - 1 ? finish : null)),
  usageFrame,
];
const sse = (frames: unknown[]) => new Response(
  `${frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

describe("the included Kimi's replies", () => {
  let home: string;
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.LATERDOG_HOME;
    home = mkdtempSync(join(tmpdir(), "ld-inline-reasoning-"));
    process.env.LATERDOG_HOME = home;
    writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true, included: ["decisions", "voice", "ai"] }));
    writeFileSync(join(home, "computers-trial-key"), `${KEY}\n`);
  });
  afterEach(() => {
    if (before === undefined) delete process.env.LATERDOG_HOME;
    else process.env.LATERDOG_HOME = before;
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function converse(responses: Response[], driver = IncludedAiDriver, instanceId = INCLUDED_AI_INSTANCE) {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const next = responses.shift();
      if (!next) throw new Error("no recorded response left");
      return next;
    }));
    const instance = await driver.create({ instanceId, displayName: "later.dog AI", enabled: true, config: {}, environment: {} });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "request.opened" && event.requestId) {
        void instance.adapter.respondToRequest(event.threadId, event.requestId, { behavior: "answer", message: "Yes, run it." });
      }
    });
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi", approvalMode: "full" });
    await vi.waitFor(() => {
      if (!events.some((event) => event.type === "turn.completed")) throw new Error("turn still running");
    }, { timeout: 10_000 });
    await instance.dispose();
    const deltas = (kind: "assistant_text" | "reasoning_text") =>
      events.flatMap((event) => event.type === "content.delta" && event.streamKind === kind ? [event.delta] : []).join("");
    const replies = events.flatMap((event) => event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : []);
    return { events, bodies, replies, reply: deltas("assistant_text"), reasoning: deltas("reasoning_text") };
  }

  it("saves only the answer, with the reasoning on the reasoning stream", async () => {
    const turn = await converse([sse(recorded(HELLO_TRACE))]);
    expect(turn.replies).toEqual(["hello from cloud"]);
    expect(turn.reply).toBe("hello from cloud");
    expect(turn.reasoning).toBe(HELLO_REASONING);
    expect(turn.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("keeps reasoning out of tool rounds and out of what it sends back", async () => {
    const ask = { index: 0, id: "call_ask", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ questions: [{ question: "Run ps?" }] }) } };
    const turn = await converse([
      sse([
        frame({ role: "assistant", content: "" }),
        frame({ content: "The user wants me to run a shell command and reply with ONLY its raw output." }),
        frame({ content: " I should check first.</thi" }),
        frame({ content: "nk>" }),
        frame({ tool_calls: [ask] }, "tool_calls"),
        usageFrame,
      ]),
      sse(recorded(PS_TRACE)),
    ]);
    expect(turn.replies).toEqual([PS_OUTPUT]);
    expect(turn.reply).toBe(PS_OUTPUT);
    expect(turn.reasoning).toContain("I should check first.");
    expect(turn.reasoning).toContain("Let me extract just the stdout");
    expect(turn.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    const replayed = turn.bodies[1]!.messages.find((message) => message.role === "assistant");
    expect(replayed).toMatchObject({ content: null, tool_calls: [expect.objectContaining({ id: "call_ask" })] });
    expect(JSON.stringify(turn.bodies[1])).not.toContain("think>");
  });

  it("keeps a reply that has no reasoning whole", async () => {
    const turn = await converse([sse(recorded(["Hello", " there!"]))]);
    expect(turn.replies).toEqual(["Hello there!"]);
  });

  it("cleans a one-shot helper answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      model: WORKERS_MODEL,
      choices: [{ message: { role: "assistant", content: "The user wants a short title.</think>Weekend plans" }, finish_reason: "stop" }],
    })));
    const instance = await IncludedAiDriver.create({ instanceId: INCLUDED_AI_INSTANCE, displayName: "later.dog AI", enabled: true, config: {}, environment: {} });
    await expect(instance.generateText!("title this")).resolves.toBe("Weekend plans");
    await instance.dispose();
  });

  it("cleans Kimi's answer when it stands in for Grok", async () => {
    const turn = await converse([sse(recorded(HELLO_TRACE))], IncludedGrokDriver, INCLUDED_GROK_INSTANCE);
    expect(turn.replies).toEqual(["hello from cloud"]);
  });
});
