import { describe, expect, it } from "vitest";
import {
  answerable, answerOnDesk, DESK_BRAIN_KEPT_MS, deskConversation, parseBrain, WAKE_TOOL, type DeskBrain, type DeskDog,
} from "../src/desk-answer.ts";
import type { QueuedSend } from "../src/desk.ts";

const T0 = Date.UTC(2026, 9, 24, 12);
const REX: DeskDog = {
  botId: "rex", threadId: "t-rex", name: "Rex", instanceId: "laterdogAi", model: "kimi-k2.6", system: "You are Rex, a friendly dog.",
  transcript: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi!" }], leafId: "m2",
};
const BRAIN: DeskBrain = { at: T0, dogs: [REX] };
const send = (body: Record<string, unknown>, path = "/api/bots/rex/messages"): QueuedSend => ({
  id: String(body.sendId ?? "x"), path, headers: {}, body: JSON.stringify(body), at: T0, ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
});

function sse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const delta = (content: string) => ({ model: "kimi-k2.6", choices: [{ index: 0, delta: { content } }] });

describe("which sends the desk answers", () => {
  it("answers plain words to a free-model dog it has notes for", () => {
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001", threadId: "t-rex" }), BRAIN, T0)).toEqual(REX);
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001" }), BRAIN, T0)).toEqual(REX);
  });

  it("leaves everything else to the home", () => {
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001", threadId: "t-other" }), BRAIN, T0)).toBeNull();
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001", attachments: [{ id: "a" }] }), BRAIN, T0)).toBeNull();
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001", replyToId: "m1" }), BRAIN, T0)).toBeNull();
    expect(answerable(send({ text: "hi" }), BRAIN, T0)).toBeNull();
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001" }, "/api/bots/fido/messages"), BRAIN, T0)).toBeNull();
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001" }, "/api/groups/pack/messages"), BRAIN, T0)).toBeNull();
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001" }), BRAIN, T0 + DESK_BRAIN_KEPT_MS + 1)).toBeNull();
    expect(answerable(send({ text: "hi", sendId: "send-0000000000001" }), null, T0)).toBeNull();
  });

  it("reads only well-formed notes from the home", () => {
    expect(parseBrain({ at: T0, dogs: [REX, { botId: "broken" }] })).toEqual(BRAIN);
    expect(parseBrain({ dogs: [REX] })).toBeNull();
    expect(parseBrain(null)).toBeNull();
  });
});

describe("answering on the desk", () => {
  it("asks the included model with the dog's own prompt and recent words, and streams only the answer", async () => {
    const seen: string[] = [];
    let request: { url: string; auth: string | null; body: any } | null = null;
    const outcome = await answerOnDesk({
      api: "https://cloud.later.dog/v1",
      key: "ldt_key",
      dog: REX,
      messages: deskConversation(REX, [{ text: "are you there?", reply: "yes" }], "how are you?"),
      onText: (text) => seen.push(text),
      fetcher: async (url, init) => {
        request = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
        return sse([delta("<think>The person asks how I am."), delta("</think>"), delta("Doing great"), delta(", thanks!")]);
      },
    });
    expect(outcome).toEqual({ kind: "reply", text: "Doing great, thanks!" });
    expect(seen.join("")).toBe("Doing great, thanks!");
    expect(request!.url).toBe("https://cloud.later.dog/v1/ai/chat/completions");
    expect(request!.auth).toBe("Bearer ldt_key");
    expect(request!.body).toMatchObject({ model: "kimi-k2.6", stream: true, tools: [{ type: "function", function: { name: WAKE_TOOL } }] });
    expect(request!.body.messages[0].role).toBe("system");
    expect(request!.body.messages[0].content).toContain("You are Rex, a friendly dog.");
    expect(request!.body.messages.slice(1)).toEqual([
      { role: "user", content: "hello" }, { role: "assistant", content: "hi!" },
      { role: "user", content: "are you there?" }, { role: "assistant", content: "yes" },
      { role: "user", content: "how are you?" },
    ]);
  });

  it("streams a free Grok reply as it comes, since only Kimi writes its reasoning inline", async () => {
    const seen: string[] = [];
    const grok = { ...REX, model: "grok-4.3" };
    const outcome = await answerOnDesk({
      api: "https://cloud.later.dog/v1", key: "k", dog: grok, messages: deskConversation(grok, [], "hi"), onText: (text) => seen.push(text),
      fetcher: async () => sse([{ model: "grok-4.3", choices: [{ index: 0, delta: { content: "Hey" } }] }, { model: "grok-4.3", choices: [{ index: 0, delta: { content: " there!" } }] }]),
    });
    expect(outcome).toEqual({ kind: "reply", text: "Hey there!" });
    expect(seen).toEqual(["Hey", " there!"]);
  });

  it("hands the message to the home when the dog needs its computer, or the model fails", async () => {
    const wake = await answerOnDesk({
      api: "https://cloud.later.dog/v1", key: "k", dog: REX, messages: deskConversation(REX, [], "list my files"), onText: () => undefined,
      fetcher: async () => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: WAKE_TOOL, arguments: "{}" } }] } }] }]),
    });
    expect(wake.kind).toBe("home");
    const busy = await answerOnDesk({
      api: "https://cloud.later.dog/v1", key: "k", dog: REX, messages: deskConversation(REX, [], "hi"), onText: () => undefined,
      fetcher: async () => new Response("busy", { status: 503 }),
    });
    expect(busy.kind).toBe("home");
    const silent = await answerOnDesk({
      api: "https://cloud.later.dog/v1", key: "k", dog: REX, messages: deskConversation(REX, [], "hi"), onText: () => undefined,
      fetcher: async () => sse([delta("   ")]),
    });
    expect(silent.kind).toBe("home");
  });
});
