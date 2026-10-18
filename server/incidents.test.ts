import { describe, expect, it } from "vitest";

import { INCIDENT_HARD_LIMIT, IncidentLedger, incidentChip, type Incident } from "./incidents.ts";

describe("IncidentLedger", () => {
  it("goes quiet on a crash loop and starts counting again after an hour", () => {
    let now = 1_000_000;
    const ledger = new IncidentLedger({ now: () => now });
    const seen = Array.from({ length: INCIDENT_HARD_LIMIT + 1 }, () => ledger.note("t1"));
    expect(seen.map((entry) => entry.muted)).toEqual([false, false, false, false, false, true]);
    expect(ledger.note("t2")).toEqual({ muted: false });
    now += 61 * 60_000;
    expect(ledger.note("t1")).toEqual({ muted: false });
  });
});

describe("incident wording", () => {
  const incident: Incident = {
    kind: "failed",
    bot: { id: "ada", name: "Ada" },
    threadId: "t-ada",
    title: "Invoice reconciliation",
    detail: "exit_before_result",
  };

  it("names the bot, the conversation and what happened", () => {
    expect(incidentChip(incident)).toBe('Incident: Ada\'s run in its thread #Invoice reconciliation failed: "exit_before_result"');
  });

  it("words a stall and a room in their own terms", () => {
    expect(incidentChip({ ...incident, kind: "stalled", detail: "" })).toBe("Incident: Ada's run in its thread #Invoice reconciliation stopped after showing no activity");
    expect(incidentChip({ ...incident, title: null })).toContain("Ada's run in its main conversation failed");
    expect(incidentChip({ ...incident, room: "Standup" })).toContain('Ada\'s run in the room "Standup" failed');
  });
});
