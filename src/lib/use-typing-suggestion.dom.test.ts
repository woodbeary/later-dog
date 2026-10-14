// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAST_PAUSE_MS, MODEL_PAUSE_MS, type PhraseBook } from "./typing-suggestions";
import { useTypingSuggestion, type TypingSuggestion, type TypingSuggestionOptions } from "./use-typing-suggestion";

const PHRASES: PhraseBook = [{ text: "Can you fix the failing tests", count: 3, last: 1 }];
const CONTEXT = { dog: "Rex", messages: [{ role: "dog" as const, text: "Two tests fail." }], phrasing: [] };

let host: HTMLDivElement;
let root: Root;
let latest: TypingSuggestion;

function Probe(props: TypingSuggestionOptions) {
  latest = useTypingSuggestion(props);
  return null;
}

const options = (patch: Partial<TypingSuggestionOptions> = {}): TypingSuggestionOptions => ({
  enabled: true,
  blocked: false,
  text: "Can you fi",
  caretAtEnd: true,
  modelReady: false,
  rankingReady: false,
  pool: () => ({ phrases: PHRASES, dogNames: [], commands: [] }),
  context: () => CONTEXT,
  ...patch,
});

const render = (props: TypingSuggestionOptions) => act(() => root.render(createElement(Probe, props)));
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const answer = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body)));

describe("the fast path", () => {
  it("shows a phrase after a short pause, from this computer, with no request", async () => {
    const fetcher = vi.fn();
    await render(options({ fetcher: fetcher as unknown as typeof fetch, modelReady: true }));
    expect(latest.ghost).toBe("");
    await wait(FAST_PAUSE_MS - 1);
    expect(latest.ghost).toBe("");
    await wait(2);
    expect(latest.ghost).toBe("x the failing tests");
    expect(latest.source).toBe("fast");
    await wait(MODEL_PAUSE_MS + 50);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns the whole text when accepted, then shows nothing more", async () => {
    await render(options());
    await wait(FAST_PAUSE_MS + 1);
    expect(latest.accept()).toBe("Can you fix the failing tests");
    await render(options());
    expect(latest.ghost).toBe("");
  });

  it("is gone as soon as the person types, and for good when they press Escape", async () => {
    await render(options());
    await wait(FAST_PAUSE_MS + 1);
    expect(latest.ghost).not.toBe("");
    await render(options({ text: "Can you fix" }));
    expect(latest.ghost).toBe("");
    await wait(FAST_PAUSE_MS + 1);
    expect(latest.ghost).toBe(" the failing tests");
    act(() => latest.dismiss());
    expect(latest.ghost).toBe("");
    await wait(2_000);
    expect(latest.ghost).toBe("");
    await render(options({ text: "Can you fix " }));
    await wait(FAST_PAUSE_MS + 1);
    expect(latest.ghost).toBe("the failing tests");
  });
});

describe("when nothing is suggested", () => {
  it.each([
    ["it is turned off", { enabled: false }],
    ["the box is empty", { text: "" }],
    ["the box is only spaces", { text: "   " }],
    ["the person is dictating or in a secure field", { blocked: true }],
    ["the caret is not at the end", { caretAtEnd: false }],
  ])("%s", async (_name, patch) => {
    const fetcher = answer({ completion: " x", source: "cloud" });
    await render(options({ ...patch, modelReady: true, fetcher: fetcher as unknown as typeof fetch }));
    await wait(MODEL_PAUSE_MS + 500);
    expect(latest.ghost).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("the model path", () => {
  const unknown = { text: "Please take a look" };

  it("asks only when no phrase fits, after the longer pause, and shows what comes back", async () => {
    const fetcher = answer({ completion: " at the build log", source: "cloud", ms: 140 });
    await render(options({ ...unknown, modelReady: true, fetcher: fetcher as unknown as typeof fetch }));
    await wait(FAST_PAUSE_MS + 50);
    expect(fetcher).not.toHaveBeenCalled();
    await wait(MODEL_PAUSE_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(latest.ghost).toBe(" at the build log");
    expect(latest.source).toBe("cloud");
  });

  it("does not ask when no model is set up", async () => {
    const fetcher = answer({ completion: " x", source: "cloud" });
    await render(options({ ...unknown, modelReady: false, fetcher: fetcher as unknown as typeof fetch }));
    await wait(MODEL_PAUSE_MS + 500);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("drops an answer that arrives after the person has typed on", async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      finish = resolve;
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await render(options({ ...unknown, modelReady: true, fetcher: fetcher as unknown as typeof fetch }));
    await wait(MODEL_PAUSE_MS + 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await render(options({ text: "Please take a look a", modelReady: true, fetcher: fetcher as unknown as typeof fetch }));
    await act(async () => finish(new Response(JSON.stringify({ completion: " late", source: "cloud" }))));
    expect(latest.ghost).toBe("");
  });

  it("shows nothing when the model has nothing to add", async () => {
    const fetcher = answer({ completion: "", source: "cloud" });
    await render(options({ ...unknown, modelReady: true, fetcher: fetcher as unknown as typeof fetch }));
    await wait(MODEL_PAUSE_MS + 50);
    expect(latest.ghost).toBe("");
  });
});

describe("ranking tied phrases", () => {
  const tied: PhraseBook = [{ text: "Can you fix the failing tests", count: 4, last: 1 }, { text: "Can you check the build", count: 3, last: 2 }];
  const withTies = { pool: () => ({ phrases: tied, dogNames: [], commands: [] }), text: "Can you " };

  it("uses the decision model's pick when it answers in time", async () => {
    const fetcher = answer({ index: 1 });
    await render(options({ ...withTies, rankingReady: true, fetcher: fetcher as unknown as typeof fetch }));
    await wait(FAST_PAUSE_MS + 20);
    expect(latest.ghost).toBe("check the build");
    expect(latest.source).toBe("ranked");
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe("/api/typing/rank");
  });

  it("takes the most used phrase when ranking is not set up or does not pick", async () => {
    await render(options({ ...withTies, rankingReady: false }));
    await wait(FAST_PAUSE_MS + 20);
    expect(latest.ghost).toBe("fix the failing tests");
    expect(latest.source).toBe("fast");
    await render(options({ ...withTies, text: "Can you  ", rankingReady: true, fetcher: answer({ index: null }) as unknown as typeof fetch }));
    await render(options({ ...withTies, rankingReady: true, fetcher: answer({ index: null }) as unknown as typeof fetch }));
    await wait(FAST_PAUSE_MS + 20);
    expect(latest.ghost).toBe("fix the failing tests");
  });
});
