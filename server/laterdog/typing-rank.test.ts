import { describe, expect, it, vi } from "vitest";
import type { Decider } from "../decider/index.ts";
import { TYPING_RANK_JOB, TYPING_RANK_MAX_CANDIDATES, TYPING_RANK_TIMEOUT_MS, cleanCandidates, rankCandidates } from "./typing-rank.ts";

const chose = (choice: string, pTop: number, latencyMs = 40) => ({
  ok: true as const,
  provider: "jev" as const,
  latencyMs,
  answers: { type: "choice" as const, choice, pTop, margin: pTop - 0.1, probabilities: { [choice]: pTop } },
});

function fakeDecider(answer: unknown) {
  const choose = vi.fn(async () => answer);
  return { decider: { choose } as unknown as Pick<Decider, "choose">, choose };
}

describe("ranking the person's own phrases", () => {
  it("asks one choice question with the typed text, the last message and the candidates", async () => {
    const { decider, choose } = fakeDecider(chose("c1", 0.9));
    const result = await rankCandidates(decider, { typed: "Can you", lastDogMessage: "Two tests fail.", candidates: ["Can you check the build", "Can you fix the failing tests"] });
    expect(result).toEqual({ ok: true, index: 1, ms: 40 });
    expect(choose).toHaveBeenCalledTimes(1);
    const [seam, state, question, options] = choose.mock.calls[0] as unknown as [string, Record<string, string>, { options: Record<string, string> }, { timeoutMs: number }];
    expect(seam).toBe(TYPING_RANK_JOB);
    expect(state).toEqual({ typed: "Can you", last_message: "Two tests fail." });
    expect(question.options).toEqual({ c0: "Can you check the build", c1: "Can you fix the failing tests" });
    expect(options.timeoutMs).toBe(TYPING_RANK_TIMEOUT_MS);
  });

  it("maps the choice back to the person's list even when some candidates were dropped", async () => {
    const { decider } = fakeDecider(chose("c1", 0.8));
    const result = await rankCandidates(decider, { typed: "x", lastDogMessage: "", candidates: ["", "same", "same", "other one"] });
    expect(result).toMatchObject({ ok: true, index: 3 });
  });

  it("does not ask with fewer than two usable candidates", async () => {
    const { decider, choose } = fakeDecider(chose("c0", 1));
    expect(await rankCandidates(decider, { typed: "x", lastDogMessage: "", candidates: ["only", "only"] })).toEqual({ ok: false, reason: "too-few" });
    expect(choose).not.toHaveBeenCalled();
  });

  it("takes no pick when the model is unsure or does not answer", async () => {
    expect(await rankCandidates(fakeDecider(chose("c0", 0.3)).decider, { typed: "x", lastDogMessage: "", candidates: ["a b", "c d"] })).toEqual({ ok: false, reason: "unsure" });
    expect(await rankCandidates(fakeDecider({ ok: false, reason: "timeout" }).decider, { typed: "x", lastDogMessage: "", candidates: ["a b", "c d"] })).toEqual({ ok: false, reason: "unavailable" });
    expect(await rankCandidates(fakeDecider(chose("zzz", 0.9)).decider, { typed: "x", lastDogMessage: "", candidates: ["a b", "c d"] })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("hides secrets and caps how many candidates go out", () => {
    const many = Array.from({ length: 20 }, (_, index) => `phrase ${index}`);
    expect(cleanCandidates(many)).toHaveLength(TYPING_RANK_MAX_CANDIDATES);
    expect(cleanCandidates([`use sk-${"a1".repeat(16)}`])[0]!.text).toBe("use [hidden]");
  });
});
