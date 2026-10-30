// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAST_PAUSE_MS, MODEL_PAUSE_MS, PHRASE_STORE_KEY, isSecureField } from "./typing-suggestions";
import { useComposerSuggestion, type ComposerSuggestion, type ComposerSuggestionOptions } from "./use-composer-suggestion";

let host: HTMLDivElement;
let root: Root;
let suggestion: ComposerSuggestion;
let edits: string[];
let carets: number[];

function Probe(props: { options: ComposerSuggestionOptions }) {
  suggestion = useComposerSuggestion(props.options);
  return null;
}

const base = (patch: Partial<ComposerSuggestionOptions> = {}): ComposerSuggestionOptions => ({
  config: { features: { typingSuggestions: true }, typing: { enabled: true, included: false, cloudflare: { configured: false }, ranking: false } },
  text: "Can you fi",
  caret: 10,
  field: null,
  lines: [],
  dog: "Rex",
  dogNames: [],
  commands: [],
  recording: false,
  listening: false,
  locked: false,
  approval: false,
  picker: false,
  edit: (next) => edits.push(next),
  moveCaret: (at) => carets.push(at),
  ...patch,
});

const render = (options: ComposerSuggestionOptions) => act(() => root.render(createElement(Probe, { options })));
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const key = (name: string, extra: Partial<KeyboardEvent> = {}) => {
  const event = { key: name, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), ...extra };
  return { event: event as never, preventDefault: event.preventDefault };
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  localStorage.setItem(PHRASE_STORE_KEY, JSON.stringify([{ text: "Can you fix the failing tests", count: 2, last: 1 }]));
  edits = [];
  carets = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.useRealTimers();
});

describe("the keys", () => {
  it("adds the grey words on Tab and puts the caret after them", async () => {
    await render(base());
    await wait(FAST_PAUSE_MS + 1);
    expect(suggestion.ghost).toBe("x the failing tests");
    const tab = key("Tab");
    let handled = false;
    act(() => {
      handled = suggestion.onKeyDown(tab.event);
    });
    expect(handled).toBe(true);
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(edits).toEqual(["Can you fix the failing tests"]);
    expect(carets).toEqual(["Can you fix the failing tests".length]);
  });

  it("leaves Tab alone when nothing is shown, or with Shift held", async () => {
    await render(base());
    const early = key("Tab");
    expect(suggestion.onKeyDown(early.event)).toBe(false);
    expect(early.preventDefault).not.toHaveBeenCalled();
    await wait(FAST_PAUSE_MS + 1);
    const shifted = key("Tab", { shiftKey: true });
    expect(suggestion.onKeyDown(shifted.event)).toBe(false);
    expect(shifted.preventDefault).not.toHaveBeenCalled();
    expect(edits).toEqual([]);
  });

  it("dismisses on Escape, and any other key cancels but a lone modifier does not", async () => {
    await render(base());
    await wait(FAST_PAUSE_MS + 1);
    act(() => void suggestion.onKeyDown(key("Shift").event));
    expect(suggestion.ghost).not.toBe("");
    const escape = key("Escape");
    let handled = false;
    act(() => {
      handled = suggestion.onKeyDown(escape.event);
    });
    expect(handled).toBe(true);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(suggestion.ghost).toBe("");
    await render(base({ text: "Can you fix", caret: 11 }));
    await wait(FAST_PAUSE_MS + 1);
    expect(suggestion.ghost).not.toBe("");
    act(() => void suggestion.onKeyDown(key("ArrowLeft").event));
    expect(suggestion.ghost).toBe("");
  });
});

describe("when it stays away", () => {
  it("shows nothing while dictating, composing, locked, over a picker, or after the person turned it off", async () => {
    for (const patch of [{ recording: true }, { listening: true }, { locked: true }, { approval: true }, { picker: true }, { config: { features: { typingSuggestions: false } } }]) {
      await render(base(patch));
      await wait(FAST_PAUSE_MS + 50);
      expect(suggestion.ghost, JSON.stringify(patch)).toBe("");
    }
    await render(base());
    act(() => suggestion.onCompositionStart());
    await wait(FAST_PAUSE_MS + 50);
    expect(suggestion.ghost).toBe("");
    act(() => suggestion.onCompositionEnd());
    await render(base({ text: "Can you fix", caret: 11 }));
    await wait(FAST_PAUSE_MS + 50);
    expect(suggestion.ghost).not.toBe("");
  });

  it("shows nothing while a secure form is open in the chat", async () => {
    const lines = [{ role: "bot" as const, kind: "text", text: "Sign in", secureForm: { title: "Sign in", host: "example.com", fields: [], status: "open" as const } }];
    await render(base({ lines }));
    await wait(FAST_PAUSE_MS + 50);
    expect(suggestion.ghost).toBe("");
    await render(base({ lines: [{ ...lines[0]!, secureForm: { ...lines[0]!.secureForm, status: "filled" as const } }] }));
    await wait(FAST_PAUSE_MS + 50);
    expect(suggestion.ghost).not.toBe("");
  });

  it("recognises password and one-time-code fields", () => {
    const password = document.createElement("input");
    password.type = "password";
    const code = document.createElement("input");
    code.setAttribute("autocomplete", "one-time-code");
    const wrapped = document.createElement("div");
    wrapped.dataset.secureForm = "";
    const inner = document.createElement("textarea");
    wrapped.append(inner);
    const plain = document.createElement("textarea");
    expect([isSecureField(password), isSecureField(code), isSecureField(inner), isSecureField(plain), isSecureField(null)]).toEqual([true, true, true, false, false]);
  });
});

describe("smarter suggestions are opt-in", () => {
  const served = { enabled: true, included: true, cloudflare: { configured: true }, ranking: true };
  const noPhrase = { text: "Please take a look", caret: 18 };

  it("never asks a model, or the decision model, until the person turns it on", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ completion: " at it", source: "cloud" })));
    vi.stubGlobal("fetch", fetcher);
    await render(base({ ...noPhrase, config: { features: { typingSuggestions: true }, typing: served } }));
    await wait(MODEL_PAUSE_MS + 500);
    expect(fetcher).not.toHaveBeenCalled();
    expect(suggestion.ghost).toBe("");
    await render(base({ ...noPhrase, config: { features: { typingSuggestions: true, smarterSuggestions: false }, typing: served } }));
    await wait(MODEL_PAUSE_MS + 500);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks once the switch is on", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ completion: " at it", source: "cloud", ms: 5 })));
    vi.stubGlobal("fetch", fetcher);
    await render(base({ ...noPhrase, config: { features: { typingSuggestions: true, smarterSuggestions: true }, typing: served } }));
    await wait(MODEL_PAUSE_MS + 50);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(suggestion.ghost).toBe(" at it");
  });

  it("still suggests the person's own phrases with the switch off", async () => {
    await render(base({ config: { features: { typingSuggestions: true }, typing: served } }));
    await wait(FAST_PAUSE_MS + 1);
    expect(suggestion.ghost).toBe("x the failing tests");
  });
});

describe("default", () => {
  it("finishes a sentence you sent before without any switch turned on", async () => {
    await render(base({ config: { features: {} } }));
    await wait(FAST_PAUSE_MS + 50);
    expect(suggestion.ghost).toBe("x the failing tests");
  });

  it("stays quiet once you turn it off", async () => {
    await render(base({ config: { features: { typingSuggestions: false } } }));
    await wait(FAST_PAUSE_MS + 50);
    expect(suggestion.ghost).toBe("");
  });
});

describe("learning from what is sent", () => {
  it("remembers the sentences locally, and nothing once it is off", async () => {
    await render(base());
    act(() => suggestion.sent("Please open a pull request."));
    expect(JSON.parse(localStorage.getItem(PHRASE_STORE_KEY) ?? "[]").map((phrase: { text: string }) => phrase.text)).toContain("Please open a pull request");
    localStorage.clear();
    await render(base({ config: { features: { typingSuggestions: false } } }));
    act(() => suggestion.sent("Please open a pull request."));
    expect(localStorage.getItem(PHRASE_STORE_KEY)).toBeNull();
  });
});
