import { describe, expect, it } from "vitest";
import { homeLogFacts, marker, mixFrom, pick, spread } from "./swarm-load.mjs";
import { plan } from "./swarm-load-model.js";

const tools = [{ name: "Bash" }, { name: "mcp__agents__session_search" }, { name: "mcp__agents__coordinate_bots" }, { name: "mcp__agents__memory_update" }, { name: "mcp__agents__memory_log" }];
const asked = (text: string, rounds = 0) => ({ tools, messages: [{ role: "user", content: text }, ...Array.from({ length: rounds }, () => [{ role: "assistant", content: [] }, { role: "user", content: [{ type: "tool_result" }] }]).flat()] });

describe("stand-in model", () => {
  it("speaks first, then calls a tool each round, then finishes", () => {
    const text = `hi ${marker("tools", "t1", [], 0)}`;
    expect(plan(asked(text))).toMatchObject({ tool: "Bash", lead: "Working on it, swarm t1." });
    expect(plan(asked(text, 1)).lead).toBeUndefined();
    expect(plan(asked(text, 3)).text).toBe("swarm t1 done after 3 rounds.");
  });

  it("searches every dog, writes memory and fans out to teammates", () => {
    expect(plan(asked("[swarm kind=search id=s]")).input).toMatchObject({ bot: "all" });
    expect(plan(asked("[swarm kind=memory id=m]")).tool).toBe("mcp__agents__memory_update");
    expect(plan(asked(marker("fanout", "f", ["a", "b", "c"], 0))).input).toMatchObject({ bot_ids: ["a", "b", "c"], reply: "result" });
  });

  it("answers side calls with no marker at once", () => {
    expect(plan(asked("Write a title for this chat"))).toEqual({ think: 50, text: "ok" });
  });
});

describe("load driver", () => {
  it("reads stalls, reply timings and pool opens from the home log within the stage", () => {
    const log = [
      "2026-11-27T01:00:00.000Z event loop held 900 ms (abcd1234 after recall)",
      "2026-11-27T01:00:01.000Z reply timing (claudeAgent, m): started 0.1 s, first words 2.5 s, done 4.0 s",
      "2026-11-27T01:00:02.000Z 2026-11-27T01:00:02.000Z [pool] 1 2 engine opened on pool slot 3 in 250 ms",
      "2026-11-27T01:00:03.000Z 2026-11-27T01:00:03.000Z [pool] 1 2 falls back to the dog's computer after 1 ms: host_full",
      "2026-11-27T02:00:00.000Z event loop held 5000 ms",
    ].join("\n");
    const facts = homeLogFacts(log, Date.parse("2026-11-27T00:59:00Z"), Date.parse("2026-11-27T01:30:00Z"));
    expect(facts.held).toEqual([900]);
    expect(facts.heldContext).toEqual({ "after recall": 900 });
    expect(facts.replies).toEqual([{ started: 0.1, first: 2.5, done: 4 }]);
    expect(facts.pool).toMatchObject({ opened: [250], fallbacks: 1 });
  });

  it("weights the mix and summarises spreads", () => {
    const mix = mixFrom("memory=0,quick=100");
    expect(mix.find(([kind]) => kind === "memory")?.[1]).toBe(0);
    expect(pick(0, mix)).toBe("quick");
    expect(() => mixFrom("nope=1")).toThrow();
    expect(spread([3, 1, 2])).toEqual({ n: 3, p50: 2, p99: 3, max: 3 });
  });
});
