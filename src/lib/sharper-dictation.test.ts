import { describe, expect, it, vi } from "vitest";
import { dictationLanguage, sharperTranscript, sharperTranscriptOutcome, transcribeDictation } from "./sharper-dictation";

const WAV = new Uint8Array([82, 73, 70, 70, 9, 9]);
const bridge = (audio: Uint8Array<ArrayBuffer> | null = WAV) => ({ speechAudio: vi.fn(async (_file: string) => audio) });
const answering = (status: number, body: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(body, { status }));
const noWait = async () => {};

describe("the language a voice note is heard in", () => {
  it("follows the Mac's language, in the two-letter form the services know", () => {
    expect(dictationLanguage("en-US")).toBe("en");
    expect(dictationLanguage("pt_BR")).toBe("pt");
    expect(dictationLanguage("zh-Hant-TW")).toBe("zh");
    expect(dictationLanguage("nb-NO")).toBe("no");
    expect(dictationLanguage("fil-PH")).toBe("tl");
    expect(dictationLanguage("iw")).toBe("he");
  });

  it("is left to the service when it can't be named that way", () => {
    expect(dictationLanguage("yue-HK")).toBeUndefined();
    expect(dictationLanguage("")).toBeUndefined();
    expect(dictationLanguage(undefined)).toBeUndefined();
  });
});

describe("a sharper transcript", () => {
  it("sends the saved recording as WAV with the language and returns the text", async () => {
    const audio = bridge();
    const fetcher = answering(200, { text: "  Book the table for six.  ", language: "en", included: true });
    expect(await sharperTranscript("/notes/a.caf", audio, "en-GB", fetcher)).toBe("Book the table for six.");
    expect(audio.speechAudio).toHaveBeenCalledWith("/notes/a.caf");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/voice/transcribe?language=en");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "audio/wav" }, body: WAV });
  });

  it("asks without a language when the Mac's can't be named", async () => {
    const fetcher = answering(200, { text: "hola" });
    expect(await sharperTranscript("/notes/a.caf", bridge(), "yue-HK", fetcher)).toBe("hola");
    expect(fetcher.mock.calls[0]![0]).toBe("/api/voice/transcribe");
  });

  it("gives up quietly, so the on-device text stays", async () => {
    expect(await sharperTranscript("/notes/a.caf", undefined, "en", answering(200, { text: "x" }))).toBeNull();
    expect(await sharperTranscript("/notes/a.caf", {}, "en", answering(200, { text: "x" }))).toBeNull();
    expect(await sharperTranscript("/notes/a.caf", bridge(null), "en", answering(200, { text: "x" }))).toBeNull();
    expect(await sharperTranscript("/notes/a.caf", bridge(), "en", answering(409, { reason: "no-service" }))).toBeNull();
    expect(await sharperTranscript("/notes/a.caf", bridge(), "en", answering(502, { error: "down" }), noWait)).toBeNull();
    expect(await sharperTranscript("/notes/a.caf", bridge(), "en", answering(200, { text: "   " }))).toBeNull();
    expect(await sharperTranscript("/notes/a.caf", bridge(), "en", vi.fn(async () => { throw new TypeError("offline"); }), noWait)).toBeNull();
  });

  it("says why the cloud text did not arrive, so the composer can point at the missing key", async () => {
    expect(await sharperTranscriptOutcome("/notes/a.caf", bridge(), "en", answering(409, { reason: "no-service" }))).toEqual({ miss: "no-service" });
    expect(await sharperTranscriptOutcome("/notes/a.caf", bridge(), "en", answering(502, { error: "down" }), noWait)).toEqual({ miss: "failed" });
    expect(await sharperTranscriptOutcome("/notes/a.caf", bridge(null), "en", answering(200, { text: "x" }))).toEqual({ miss: "no-audio" });
    expect(await sharperTranscriptOutcome("/notes/a.caf", bridge(), "en", answering(200, { text: "hi" }))).toEqual({ text: "hi" });
  });
});

describe("when the home restarts mid-transcription", () => {
  it("asks again after a dropped connection or a gateway error, and keeps the words", async () => {
    const waits: number[] = [];
    const replies = [
      () => { throw new TypeError("connection reset"); },
      () => Response.json({ error: "dev home proxy: connect ECONNREFUSED" }, { status: 502 }),
      () => new Response("Service Unavailable", { status: 503 }),
      () => Response.json({ text: "Ship it Friday." }),
    ];
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => replies.shift()!());
    expect(await transcribeDictation(WAV, "en", fetcher, async (ms) => { waits.push(ms); })).toEqual({ text: "Ship it Friday." });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(fetcher.mock.calls.every(([, init]) => init?.body === WAV)).toBe(true);
  });

  it("stops asking after a few tries, so the voice note is saved for Retry", async () => {
    const fetcher = answering(504, { error: "timeout" });
    expect(await transcribeDictation(WAV, "en", fetcher, noWait)).toEqual({ miss: "failed" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not ask again when the answer will not change", async () => {
    for (const [status, body, outcome] of [
      [409, { reason: "no-service" }, { miss: "no-service" }],
      [409, { reason: "off" }, { miss: "off" }],
      [500, { error: "broken" }, { miss: "failed" }],
      [413, { error: "too long" }, { miss: "failed" }],
    ] as const) {
      const fetcher = answering(status, body);
      expect(await transcribeDictation(WAV, "en", fetcher, noWait)).toEqual(outcome);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("does not ask again after a request that timed out", async () => {
    const fetcher = vi.fn(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); });
    expect(await transcribeDictation(WAV, "en", fetcher, noWait)).toEqual({ miss: "failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
