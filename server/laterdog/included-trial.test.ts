import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deciderCredential, voiceCredential } from "../included-services.ts";
import { INCLUDED_DEFAULT_VOICE, describeVoice, voiceReady } from "../tts/index.ts";
import { trialDecider, trialVoice } from "./included-trial.ts";

const KEY = `ldt_${"a".repeat(43)}`;
let home: string;
let before: string | undefined;

beforeEach(() => {
  before = process.env.LATERDOG_HOME;
  home = mkdtempSync(join(tmpdir(), "ld-included-"));
  process.env.LATERDOG_HOME = home;
});
afterEach(() => {
  if (before === undefined) delete process.env.LATERDOG_HOME;
  else process.env.LATERDOG_HOME = before;
  rmSync(home, { recursive: true, force: true });
});

const trial = (state: Record<string, unknown>, key: string | null = KEY) => {
  writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "https://cloud.later.dog/v1", ...state }));
  if (key) writeFileSync(join(home, "computers-trial-key"), `${key}\n`);
};

describe("decisions and voice included with the free trial", () => {
  it("use the trial key with later.dog's own relay once the trial is confirmed", () => {
    trial({ confirmed: true, included: ["decisions", "voice", "ai"] });
    expect(trialDecider()).toEqual({ token: KEY, api: "https://cloud.later.dog", included: true });
    expect(trialVoice()).toEqual({ token: KEY, api: "https://cloud.later.dog/v1/voice", included: true });
    expect(deciderCredential(undefined, undefined, {})).toEqual({ token: KEY, api: "https://cloud.later.dog", included: true });
    expect(voiceCredential(undefined, {})).toEqual({ token: KEY, api: "https://cloud.later.dog/v1/voice", included: true });
  });

  it("offer only what cloud.later.dog says is set up; a trial saved before the list existed gets decisions only", () => {
    trial({ confirmed: true });
    expect(trialDecider()).not.toBeNull();
    expect(trialVoice()).toBeNull();
    trial({ confirmed: true, included: ["decisions"] });
    expect(trialVoice()).toBeNull();
    trial({ confirmed: true, included: [] });
    expect(trialDecider()).toBeNull();
    trial({ confirmed: true, included: ["voice"] });
    expect(trialVoice()).not.toBeNull();
    expect(trialDecider()).toBeNull();
  });

  it("never stand in for a key the person saved", () => {
    trial({ confirmed: true, included: ["decisions", "voice", "ai"] });
    expect(deciderCredential("own-jev-key", undefined, {})).toMatchObject({ token: "own-jev-key", included: false });
    expect(voiceCredential("own-eleven-key", {})).toMatchObject({ token: "own-eleven-key", included: false });
  });

  it("are not offered before the trial is confirmed, after it ends, or without a valid key", () => {
    expect(trialDecider()).toBeNull();
    trial({});
    expect(trialDecider()).toBeNull();
    trial({ confirmed: true, ended: true });
    expect(trialVoice()).toBeNull();
    trial({ confirmed: true }, "not-a-trial-key");
    expect(trialDecider()).toBeNull();
    expect(voiceCredential(undefined, {})).toBeNull();
  });
});

describe("voice with the free trial", () => {
  it("speaks with an included voice before the person picks one, and keeps their pick after", () => {
    expect(voiceReady({} as never)).toBe(false);
    trial({ confirmed: true, included: ["decisions", "voice"] });
    expect(voiceReady({} as never)).toBe(true);
    expect(describeVoice({} as never)).toMatchObject({ ready: true, included: true, voice: INCLUDED_DEFAULT_VOICE });
    expect(describeVoice({ tts: { voice: "EXAVITQu4vr4xnSDxMaL" } } as never)).toMatchObject({ voice: "EXAVITQu4vr4xnSDxMaL" });
  });
});
