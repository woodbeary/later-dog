import { describe, expect, it } from "vitest";
import { SkillsPromptCache, type SkillsPromptSource } from "./skills-prompt-cache.ts";

function source(answers: Array<() => Promise<string>>): SkillsPromptSource & { asked: number } {
  const made = {
    asked: 0,
    compose: () => answers[Math.min(made.asked++, answers.length - 1)]!(),
    close: async () => {},
  };
  return made;
}

describe("skills prompt cache", () => {
  it("answers fresh within its wait, then the last good prompt while a stuck read keeps going, never blocking", async () => {
    let release: (text: string) => void = () => {};
    const feed = source([async () => "skills one", () => new Promise<string>((resolve) => { release = resolve; })]);
    const cache = new SkillsPromptCache(feed, 20);
    expect(await cache.get("dog", undefined)).toEqual({ text: "skills one", fresh: true });
    const started = Date.now();
    expect(await cache.get("dog", undefined)).toEqual({ text: "skills one", fresh: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await cache.get("dog", undefined)).toEqual({ text: "skills one", fresh: false });
    expect(feed.asked).toBe(2);
    release("skills two");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await cache.get("dog", undefined)).text).toBe("skills two");
    expect(feed.asked).toBe(3);
  });

  it("answers empty for a dog it never read when the read is stuck or fails", async () => {
    const cache = new SkillsPromptCache(source([() => Promise.reject(new Error("ETIMEDOUT"))]), 20);
    expect(await cache.get("other", ["a"])).toEqual({ text: "", fresh: false });
  });
});
