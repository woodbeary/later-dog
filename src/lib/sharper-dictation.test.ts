import { describe, expect, it, vi } from "vitest";
import { dictationLanguage, sharperTranscript, sharperTranscriptOutcome } from "./sharper-dictation";

const WAV = new Uint8Array([82, 73, 70, 70, 9, 9]);
const bridge = (audio: Uint8Array<ArrayBuffer> | null = WAV) => ({ speechAudio: vi.fn(async (_file: string) => audio) });
const answering = (status: number, body: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(body, { status }));

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
    expect(await sharperTranscript("/notes/a.caf", bridge(), "en", answering(502, { error: "down" }))).toBeNull();
    expect(await sharperTranscript("/notes/a.caf", bridge(), "en", answering(200, { text: "   " }))).toBeNull();
    expect(await sharperTranscript("/notes/a.caf", bridge(), "en", vi.fn(async () => { throw new TypeError("offline"); }))).toBeNull();
  });

  it("says why the cloud text did not arrive, so the composer can point at the missing key", async () => {
    expect(await sharperTranscriptOutcome("/notes/a.caf", bridge(), "en", answering(409, { reason: "no-service" }))).toEqual({ miss: "no-service" });
    expect(await sharperTranscriptOutcome("/notes/a.caf", bridge(), "en", answering(502, { error: "down" }))).toEqual({ miss: "failed" });
    expect(await sharperTranscriptOutcome("/notes/a.caf", bridge(null), "en", answering(200, { text: "x" }))).toEqual({ miss: "no-audio" });
    expect(await sharperTranscriptOutcome("/notes/a.caf", bridge(), "en", answering(200, { text: "hi" }))).toEqual({ text: "hi" });
  });
});
