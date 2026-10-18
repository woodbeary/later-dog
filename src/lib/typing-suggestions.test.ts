import { describe, expect, it, vi } from "vitest";
import {
  MAX_PHRASES,
  PHRASE_STORE_KEY,
  askModel,
  askRanking,
  buildTypingContext,
  fastCandidates,
  learnPhrases,
  loadPhrases,
  pickFast,
  savePhrases,
  suggestionsBlocked,
  type Candidate,
  type PhraseBook,
  type SuggestionPool,
} from "./typing-suggestions";

const NOW = 1_800_000_000_000;
const book = (...texts: Array<string | [string, number]>): PhraseBook =>
  texts.map((entry, index) => ({ text: Array.isArray(entry) ? entry[0] : entry, count: Array.isArray(entry) ? entry[1] : 1, last: NOW - index }));
const pool = (phrases: PhraseBook = [], dogNames: string[] = [], commands: string[] = []): SuggestionPool => ({ phrases, dogNames, commands });

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

describe("learning the person's own phrases", () => {
  it("keeps sentences of a few words, counts repeats and drops the full stop", () => {
    let learned = learnPhrases([], "Can you fix the failing tests. Thanks!", NOW);
    expect(learned.map((phrase) => phrase.text)).toEqual(["Can you fix the failing tests"]);
    learned = learnPhrases(learned, "can you fix the failing tests?", NOW + 5);
    expect(learned).toEqual([{ text: "Can you fix the failing tests", count: 2, last: NOW + 5 }]);
  });

  it("learns nothing from commands, links, code, tags, secrets or one-word replies", () => {
    for (const sent of ["/goal ship the release today", "see https://example.com/a/b for details", "run `pnpm test` again please", "<attached-image path=x> look at this one", `use sk-${"a1".repeat(16)} for the call`, "ok", "sounds good", "x ".repeat(30)]) {
      expect(learnPhrases([], sent, NOW), sent).toEqual([]);
    }
  });

  it("keeps the most used phrases when the book is full", () => {
    let learned: PhraseBook = [];
    for (let index = 0; index < MAX_PHRASES + 20; index += 1) learned = learnPhrases(learned, `please look at thing number ${index} soon`, NOW + index);
    learned = learnPhrases(learned, `please look at thing number ${MAX_PHRASES + 10} soon`, NOW + 999);
    expect(learned).toHaveLength(MAX_PHRASES);
    expect(learned[0]).toMatchObject({ text: `please look at thing number ${MAX_PHRASES + 10} soon`, count: 2 });
  });

  it("stores them locally, and ignores anything unreadable or secret", () => {
    const storage = memory();
    savePhrases(book("Can you fix the failing tests"), storage);
    expect(loadPhrases(storage)).toHaveLength(1);
    storage.data.set(PHRASE_STORE_KEY, JSON.stringify([{ text: `token: ${"a1".repeat(10)}`, count: 1, last: 1 }, { text: "fine words here", count: 1, last: 1 }, 5]));
    expect(loadPhrases(storage).map((phrase) => phrase.text)).toEqual(["fine words here"]);
    storage.data.set(PHRASE_STORE_KEY, "not json");
    expect(loadPhrases(storage)).toEqual([]);
    expect(loadPhrases(undefined)).toEqual([]);
  });
});

describe("the fast path", () => {
  const phrases = book(["Can you fix the failing tests", 4], ["Can you check the build", 2], ["Please open a pull request", 1]);

  it("finishes a phrase from what has been typed", () => {
    expect(fastCandidates("Can you fi", pool(phrases))[0]).toMatchObject({ kind: "phrase", completion: "x the failing tests" });
    expect(fastCandidates("please open", pool(phrases))[0]?.completion).toBe(" a pull request");
  });

  it("matches the end of a longer sentence, and prefers the longest match", () => {
    const found = fastCandidates("Thanks for that. Can you fix", pool(phrases));
    expect(found[0]).toMatchObject({ completion: " the failing tests", matched: "Can you fix".length });
    const mid = fastCandidates("ok so can you ch", pool(phrases));
    expect(mid[0]?.completion).toBe("eck the build");
  });

  it("needs a few characters and an actual continuation", () => {
    expect(fastCandidates("Ca", pool(phrases))).toEqual([]);
    expect(fastCandidates("", pool(phrases))).toEqual([]);
    expect(fastCandidates("Can you check the build", pool(phrases))).toEqual([]);
    expect(fastCandidates("zebra", pool(phrases))).toEqual([]);
  });

  it("breaks ties toward the phrase used most", () => {
    const found = fastCandidates("Can you ", pool(phrases));
    expect(found.map((candidate) => candidate.completion)).toEqual(["fix the failing tests", "check the build"]);
  });

  it("finishes a dog's name, but leaves @ mentions and slash commands to their own pickers' words", () => {
    expect(fastCandidates("ask Re", pool([], ["Rex", "Scout"]))[0]).toMatchObject({ kind: "dog", completion: "x" });
    expect(fastCandidates("ask @Re", pool([], ["Rex"]))).toEqual([]);
    expect(fastCandidates("/go", pool([], [], ["/goal", "/learn"]))[0]).toMatchObject({ kind: "command", completion: "al " });
    expect(fastCandidates("/xyz", pool([], [], ["/goal"]))).toEqual([]);
  });

  it("is nothing when nothing is known", () => {
    expect(fastCandidates("Can you fix", pool())).toEqual([]);
  });
});

describe("choosing between fast candidates", () => {
  const candidate = (completion: string, matched: number, weight = 1, kind: Candidate["kind"] = "phrase"): Candidate => ({ kind, completion, matched, weight });

  it("takes the first, which has the longest match", () => {
    expect(pickFast([candidate("a", 5), candidate("b", 3)])).toEqual({ best: candidate("a", 5), tied: [] });
    expect(pickFast([])).toEqual({ best: null, tied: [] });
  });

  it("offers the ones that tie for the longest match for ranking", () => {
    const tied = pickFast([candidate("a", 5, 3), candidate("b", 5, 1), candidate("c", 2)]).tied;
    expect(tied.map((entry) => entry.completion)).toEqual(["a", "b"]);
  });
});

describe("what the model is told", () => {
  it("is the last few chat messages, with no cards, secrets or empty lines", () => {
    const lines = Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? ("bot" as const) : ("user" as const), kind: "text", text: `message ${index}` }));
    lines.splice(3, 0, { role: "bot", kind: "text", text: "form", secureForm: {} } as never, { role: "bot", kind: "activity", text: "tool" });
    const context = buildTypingContext(lines, "Rex", book("one two three", "four five six", "seven eight nine", "ten eleven twelve"));
    expect(context.dog).toBe("Rex");
    expect(context.messages).toHaveLength(6);
    expect(context.messages.at(-1)).toEqual({ role: "person", text: "message 8" });
    expect(context.messages.some((message) => message.text === "form" || message.text === "tool")).toBe(false);
    expect(context.phrasing).toEqual(["one two three", "four five six", "seven eight nine"]);
  });
});

describe("when suggestions stay away", () => {
  const free = { recording: false, listening: false, locked: false, approval: false, secureFormOpen: false, picker: false, composing: false, field: null };
  it("shows nothing while dictating, locked, waiting on an approval, in a secure form, over a picker or composing", () => {
    expect(suggestionsBlocked(free)).toBe(false);
    for (const key of ["recording", "listening", "locked", "approval", "secureFormOpen", "picker", "composing"] as const) {
      expect(suggestionsBlocked({ ...free, [key]: true }), key).toBe(true);
    }
  });
});

describe("asking the model", () => {
  const ctx = { dog: "Rex", messages: [{ role: "dog" as const, text: "Two tests fail." }], phrasing: ["Can you look at"] };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("sends the typed text with the chat context and reads the completion", async () => {
    const fetcher = vi.fn(async () => reply({ completion: " the failing tests", source: "cloud", ms: 120 }));
    const answer = await askModel("Please fix", ctx, new AbortController().signal, fetcher as unknown as typeof fetch);
    expect(answer).toEqual({ completion: " the failing tests", source: "cloud", ms: 120 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/typing/complete");
    expect(JSON.parse(String(init.body))).toEqual({ prefix: "Please fix", dog: "Rex", messages: ctx.messages, phrasing: ctx.phrasing });
  });

  it("asks nothing about text that looks like a secret", async () => {
    const fetcher = vi.fn();
    expect(await askModel(`my key is sk-${"a1".repeat(16)}`, ctx, new AbortController().signal, fetcher as unknown as typeof fetch)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows nothing for an empty, odd, failed or unreachable answer", async () => {
    const signal = new AbortController().signal;
    for (const answer of [reply({ completion: "" }), reply({ completion: "x", source: "other" }), reply({}, 500), reply("x")]) {
      expect(await askModel("Please fix", ctx, signal, (async () => answer) as unknown as typeof fetch)).toBeNull();
    }
    expect(await askModel("Please fix", ctx, signal, (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBeNull();
  });

  it("asks for one pick among candidates, and accepts only a valid index", async () => {
    const candidates: Candidate[] = [{ kind: "phrase", completion: " a b", matched: 3, weight: 1 }, { kind: "phrase", completion: " c d", matched: 3, weight: 1 }];
    const signal = new AbortController().signal;
    const fetcher = vi.fn(async () => reply({ index: 1 }));
    expect(await askRanking("Can", "hi", candidates, signal, fetcher as unknown as typeof fetch)).toBe(1);
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ typed: "Can", lastMessage: "hi", candidates: ["a b", "c d"] });
    expect(await askRanking("Can", "hi", candidates, signal, (async () => reply({ index: 7 })) as unknown as typeof fetch)).toBeNull();
    expect(await askRanking("Can", "hi", candidates, signal, (async () => reply({ index: null })) as unknown as typeof fetch)).toBeNull();
    expect(await askRanking("Can", "hi", candidates, signal, (async () => reply({}, 500)) as unknown as typeof fetch)).toBeNull();
  });
});
