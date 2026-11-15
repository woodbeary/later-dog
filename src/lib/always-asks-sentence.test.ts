import { describe, expect, it } from "vitest";
import { ALWAYS_ASK_IDS, ALWAYS_ASK_WORDS } from "../../shared/always-asks";
import { en } from "@/locales";
import { alwaysAsksSentence } from "./always-asks-sentence";
import { setLocale } from "./i18n";

describe("what still asks, in the approval settings", () => {
  it("is one sentence that names every rule the server holds, in its order, and nothing else", () => {
    setLocale("en");
    const sentence = alwaysAsksSentence();
    expect(sentence).toBe(
      "Whatever the approval setting, every dog asks you before it pushes code without running its checks, makes a sign-in key or client in a cloud account, deletes files outside its own folders, sends or posts as you from a connected app, or pays or moves money, unless you chose Always on that card.",
    );
    const words = ALWAYS_ASK_IDS.map((id) => en[ALWAYS_ASK_WORDS[id]]);
    const at = words.map((phrase) => sentence.indexOf(phrase));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const named = Object.keys(en).filter((key) => key.startsWith("askFirst.always."));
    expect(named.sort()).toEqual(Object.values(ALWAYS_ASK_WORDS).sort());
  });
});
