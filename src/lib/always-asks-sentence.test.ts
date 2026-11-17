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
      "Whatever its approval setting, every dog asks you before it pushes code without running its checks, makes a sign-in key or client in a cloud account, deletes files outside its own folders, here or on your Mac, sends, posts or invites as you from a connected app, pays or moves money from a connected app, or deletes something or changes who can see it in a connected app, every time; it goes by how a command is written, so it catches slips, not a dog set on getting around it.",
    );
    const words = ALWAYS_ASK_IDS.map((id) => en[ALWAYS_ASK_WORDS[id]]);
    const at = words.map((phrase) => sentence.indexOf(phrase));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const named = Object.keys(en).filter((key) => key.startsWith("askFirst.always."));
    expect(named.sort()).toEqual(Object.values(ALWAYS_ASK_WORDS).sort());
  });
});
