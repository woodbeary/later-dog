import { describe, expect, it, vi } from "vitest";
import { SEED_GREETING, firstHelloPrompt, personalGreeting, sayFirstHello, type FirstHelloDeps } from "./first-hello.ts";

function fixture(messages: { id: string; role: string; kind?: string; text?: string }[], canRun = true) {
  const patched: { id: string; text: string }[] = [];
  const started: string[] = [];
  const deps: FirstHelloDeps = {
    bot: (id) => (id === "dog" ? { id: "dog", name: "Biscuit", threadId: "t1", modelSelection: { instanceId: "claude" } } : undefined),
    messages: () => messages,
    patchMessage: (_thread, id, patch) => { patched.push({ id, text: patch.text }); },
    personName: () => "Jacob",
    canRun: vi.fn(async () => canRun),
    start: vi.fn(async (_bot, _thread, prompt) => { started.push(prompt); }),
  };
  return { deps, patched, started };
}
// What store.createBot seeds, with the name the dog had before the person renamed it.
const seed = { id: "m1", role: "bot", kind: "text", text: "Hi, I'm Pepper. What would you like me to do?" };

describe("the first dog speaks first", () => {
  it("rewrites the seeded greeting with the person's and the dog's current names, then asks one question", async () => {
    const { deps, patched, started } = fixture([seed]);
    expect(await sayFirstHello(deps, "dog")).toEqual({ greeted: true, asked: true });
    expect(patched).toEqual([{ id: "m1", text: "Hi Jacob, I'm Biscuit." }]);
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("do not greet again");
    expect(started[0]).toContain("what should you help with first");
  });

  it("keeps the corrected greeting and starts no turn when the dog's engine cannot answer yet", async () => {
    const { deps, patched, started } = fixture([seed], false);
    expect(await sayFirstHello(deps, "dog")).toEqual({ greeted: true, asked: false });
    expect(patched).toHaveLength(1);
    expect(started).toEqual([]);
  });

  it("does nothing in a chat the person has written in, and asks only once", async () => {
    const talked = fixture([seed, { id: "m2", role: "user", kind: "text", text: "hi" }]);
    expect(await sayFirstHello(talked.deps, "dog")).toEqual({ greeted: false, asked: false });
    expect(talked.patched).toEqual([]);
    const asked = fixture([{ ...seed, text: "Hi Jacob, I'm Biscuit." }, { id: "m2", role: "bot", kind: "card" }]);
    expect(await sayFirstHello(asked.deps, "dog")).toEqual({ greeted: false, asked: false });
    expect(asked.started).toEqual([]);
  });

  it("matches only the seeded greeting and says hello without a name when there is none", () => {
    expect(SEED_GREETING.test("Hi, I'm Pepper. What would you like me to do?")).toBe(true);
    expect(SEED_GREETING.test("Hi, I'm Pepper. Let's go.")).toBe(false);
    expect(personalGreeting(undefined, "Biscuit")).toBe("Hi, I'm Biscuit.");
    expect(firstHelloPrompt(undefined, "Biscuit")).toContain("the person just finished setting you up");
  });
});
