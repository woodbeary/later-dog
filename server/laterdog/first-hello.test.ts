import { describe, expect, it, vi } from "vitest";
import { SEED_GREETING, firstHelloPrompt, personalGreeting, sayFirstHello, type FirstHelloDeps } from "./first-hello.ts";

function fixture(messages: { id: string; role: string; kind?: string; text?: string }[], canRun = true, title?: string) {
  const patched: { id: string; text: string; kind?: string }[] = [];
  const started: string[] = [];
  const deps: FirstHelloDeps = {
    bot: (id) => (id === "dog" ? { id: "dog", name: "Biscuit", title, threadId: "t1", modelSelection: { instanceId: "claude" } } : undefined),
    messages: () => messages,
    patchMessage: (_thread, id, patch) => { patched.push({ id, ...patch }); },
    personName: () => "Jacob",
    canRun: vi.fn(async () => canRun),
    start: vi.fn(async (_bot, _thread, prompt) => { started.push(prompt); }),
  };
  return { deps, patched, started };
}
const seed = { id: "m1", role: "bot", kind: "text", text: "Hi, I'm Pepper. What would you like me to do?" };

describe("the first dog speaks first", () => {
  it("lets the dog greet in one warm message that guesses its purpose, then ask one tailored question", async () => {
    const { deps, patched, started } = fixture([seed]);
    expect(await sayFirstHello(deps, "dog")).toEqual({ greeted: true, asked: true });
    expect(patched).toEqual([{ id: "m1", text: "Hi Jacob, I'm Biscuit." }, { id: "m1", kind: "activity", text: "" }]);
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("Say hello first, in one warm message");
    expect(started[0]).toContain("greet Jacob by name");
    expect(started[0]).toContain("say what you guess you are here for from your name, Biscuit");
    expect(started[0]).toContain("Do not introduce yourself by name and do not add a second message");
    expect(started[0]).toContain("never generic ones such as Code and GitHub");
    expect(started[0]).toContain("Once they answer, start on what they asked right away");
    expect(started[0]).toContain(
      "If they close the question without answering, do not ask it again: tell them in one short line that you are ready whenever they are, and stop.",
    );
  });

  it("tells the dog what the person said it is for, so the options fit that purpose", async () => {
    const { deps, started } = fixture([seed], true, "Email and calendar");
    expect(await sayFirstHello(deps, "dog")).toEqual({ greeted: true, asked: true });
    expect(started[0]).toContain('wrote what you are for: "Email and calendar"');
    expect(started[0]).toContain("say what you guess you are here for from that purpose");
    expect(firstHelloPrompt("Jacob", "Biscuit", "  ")).toContain("from your name, Biscuit");
  });

  it("starts the hello as the person who introduced the dog, so it can do their first ask with their computer", async () => {
    const { deps } = fixture([seed]);
    await sayFirstHello(deps, "dog", "cloud-home");
    expect(deps.start).toHaveBeenCalledWith("dog", "t1", expect.stringContaining("first meeting"), "cloud-home");
  });

  it("keeps a corrected greeting and starts no turn when the dog's engine cannot answer yet", async () => {
    const { deps, patched, started } = fixture([seed], false);
    expect(await sayFirstHello(deps, "dog")).toEqual({ greeted: true, asked: false });
    expect(patched).toEqual([{ id: "m1", text: "Hi Jacob, I'm Biscuit." }]);
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
    expect(firstHelloPrompt(undefined, "Biscuit")).toContain("greet them by name");
  });
});
