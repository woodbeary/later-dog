import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { EngineContextAsk, ENGINE_CONTEXT_REQUEST_PREFIX, writeEngineLine } from "./engine-context-ask.ts";

function engine(timeoutMs = 1_000) {
  const written: Array<{ type: string; request_id: string; request: { subtype: string; detail?: string } }> = [];
  const ask = new EngineContextAsk(async (line) => {
    written.push(JSON.parse(line));
    return true;
  }, timeoutMs);
  const reply = (response: Record<string, unknown>) => ask.receive({ type: "control_response", response: { request_id: written.at(-1)!.request_id, ...response } });
  return { ask, written, reply };
}

describe("asking the engine what fills the context window", () => {
  it("writes one control request line in the engine's envelope, asking for the cheap summary", async () => {
    const { ask, written, reply } = engine();
    const asked = ask.ask();
    expect(written).toEqual([{ type: "control_request", request_id: expect.stringMatching(new RegExp(`^${ENGINE_CONTEXT_REQUEST_PREFIX}`)), request: { subtype: "get_context_usage", detail: "summary" } }]);
    expect(reply({ subtype: "success", response: { totalTokens: 5, maxTokens: 10, categories: [] } })).toBe(true);
    expect(await asked).toEqual({ kind: "answer", answer: { totalTokens: 5, maxTokens: 10, categories: [] } });
  });

  it("shares one question between callers who ask at the same time", async () => {
    const { ask, written, reply } = engine();
    const first = ask.ask();
    const second = ask.ask();
    expect(written).toHaveLength(1);
    reply({ subtype: "success", response: {} });
    expect(await first).toEqual(await second);
  });

  it("remembers an engine that does not know the request and never asks it again", async () => {
    const { ask, written, reply } = engine();
    const asked = ask.ask();
    reply({ subtype: "error", error: "Unsupported control request subtype: get_context_usage" });
    expect(await asked).toEqual({ kind: "refused" });
    expect(await ask.ask()).toEqual({ kind: "refused" });
    expect(written).toHaveLength(1);
    expect(ask.knowsRefusal).toBe(true);
  });

  it("asks again later when the engine has had no turn yet", async () => {
    const { ask, written, reply } = engine();
    const asked = ask.ask();
    reply({ subtype: "error", error: "getContextUsage: no turn received yet" });
    expect(await asked).toEqual({ kind: "not-yet" });
    const again = ask.ask();
    expect(written).toHaveLength(2);
    reply({ subtype: "success", response: { ok: 1 } });
    expect(await again).toEqual({ kind: "answer", answer: { ok: 1 } });
  });

  it("gives up on an engine that stays silent, and stops asking after it stays silent twice", async () => {
    const { ask, written } = engine(20);
    expect(await ask.ask()).toEqual({ kind: "none" });
    expect(ask.knowsRefusal).toBe(false);
    expect(await ask.ask()).toEqual({ kind: "none" });
    expect(await ask.ask()).toEqual({ kind: "refused" });
    expect(written).toHaveLength(2);
  });

  it("keeps asking an engine that answers late, because a slow engine is not one that refuses", async () => {
    const { ask, written } = engine(20);
    const late = (index: number) => ask.receive({ type: "control_response", response: { subtype: "success", request_id: written[index]!.request_id, response: {} } });
    expect(await ask.ask()).toEqual({ kind: "none" });
    expect(late(0)).toBe(true);
    expect(await ask.ask()).toEqual({ kind: "none" });
    expect(late(1)).toBe(true);
    expect(ask.knowsRefusal).toBe(false);
    const third = ask.ask();
    expect(written).toHaveLength(3);
    ask.receive({ type: "control_response", response: { subtype: "success", request_id: written[2]!.request_id, response: { ok: 1 } } });
    expect(await third).toEqual({ kind: "answer", answer: { ok: 1 } });
  });

  it("leaves every other line from the engine alone", () => {
    const { ask } = engine();
    void ask.ask();
    expect(ask.receive({ type: "control_response", response: { request_id: "set-mode-1", subtype: "success" } })).toBe(false);
    expect(ask.receive({ type: "result", is_error: false })).toBe(false);
    expect(ask.receive({ type: "assistant", message: { content: [] } })).toBe(false);
    expect(ask.receive(null)).toBe(false);
    ask.close();
  });

  it("answers at once when the line cannot be written", async () => {
    const ask = new EngineContextAsk(async () => false, 10_000);
    expect(await ask.ask()).toEqual({ kind: "none" });
  });

  it("writes to an engine's input without throwing when the engine has gone", async () => {
    const stdin = new PassThrough();
    expect(await writeEngineLine(stdin, "{}\n")).toBe(true);
    stdin.destroy();
    expect(await writeEngineLine(stdin, "{}\n")).toBe(false);
  });
});
