import { describe, expect, it } from "vitest";

import { DECISION_MODELS, decisionCalls, decisionItems, gradeDecision, ruleCorrect, ruleRoomResponder, ruleWaitingOnOwner } from "./cases.ts";
import {
  RESET_FIELDS, calendarDate, clockTime, extractionCalls, extractionFixture, parseExtraction, resetWallClock, ruleResetWallClock,
  ruleShortText, spanSupports, wallClockIn,
} from "./extraction.ts";
import {
  abstainSweep, accuracy, accuracyWithFallback, brier, costPerThousand, expectedCalibrationError, latencySummary, percentile, reciprocalRank,
  reliability, type Graded,
} from "./metrics.ts";
import { renderMarkdown, scoreAll, type Receipt } from "./score.ts";

const graded = (id: string, correct: boolean, confidence: number): Graded => ({ id, correct, confidence });

describe("decision metrics", () => {
  const rows = [graded("a", true, 0.95), graded("b", true, 0.9), graded("c", false, 0.9), graded("d", false, 0.55), graded("e", true, 0.65)];

  it("scores accuracy and the Brier score from confidence in the answer given", () => {
    expect(accuracy(rows)).toBeCloseTo(0.6);
    expect(brier(rows)).toBeCloseTo((0.05 ** 2 + 0.1 ** 2 + 0.9 ** 2 + 0.55 ** 2 + 0.35 ** 2) / 5);
    expect(accuracy([])).toBeNull();
  });

  it("puts each answer in one reliability bin, the top bin closed at 1", () => {
    const bins = reliability([...rows, graded("f", true, 1)]);
    expect(bins.reduce((total, bin) => total + bin.count, 0)).toBe(6);
    expect(bins.find((bin) => bin.from === 0.9)).toMatchObject({ count: 2, accuracy: 0.5 });
    expect(bins.at(-1)).toMatchObject({ from: 0.95, count: 2, accuracy: 1 });
    expect(expectedCalibrationError(rows)).toBeGreaterThan(0);
  });

  it("answers fewer questions and gets fewer wrong as the threshold rises", () => {
    const sweep = abstainSweep(rows, [0.5, 0.9, 0.95]);
    expect(sweep.map((point) => point.answered)).toEqual([5, 3, 1]);
    expect(sweep.map((point) => point.wrongWhenAnswered)).toEqual([2, 1, 0]);
    expect(sweep[2]!.accuracyWhenAnswered).toBe(1);
  });

  it("uses the rule for answers under the threshold and for questions with no answer", () => {
    const model = new Map(rows.map((row) => [row.id, row]));
    const rule = new Map([["a", false], ["b", false], ["c", true], ["d", true], ["e", false], ["missing", true]]);
    expect(accuracyWithFallback(["a", "b", "c", "d", "e", "missing"], model, rule, 0.6)).toBeCloseTo(5 / 6);
    expect(accuracyWithFallback(["a", "b", "c", "d", "e", "missing"], model, rule, 0.99)).toBeCloseTo(3 / 6);
  });

  it("summarises latency, cost and rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeNull();
    expect(latencySummary([100, 200, 2_000], 1_500)).toEqual({ count: 3, p50: 200, p95: 2_000, worst: 2_000, overBudget: 1 });
    expect(costPerThousand([500, 700], 0.24)).toBeCloseTo(0.144);
    expect(reciprocalRank({ a: 0.5, b: 0.3, c: 0.2 }, "b")).toBe(0.5);
    expect(reciprocalRank({ a: 1 }, "z")).toBe(0);
  });
});

describe("decision cases", () => {
  const items = decisionItems();

  it("plans one request per item and model inside the decision model's limits", () => {
    const calls = decisionCalls(items, DECISION_MODELS);
    expect(calls).toHaveLength(items.length * 2);
    expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
    for (const call of calls) {
      expect(Buffer.byteLength(JSON.stringify(call.body))).toBeLessThan(64 * 1024);
      expect(call.body.model).toBe(call.model);
    }
  });

  it("keeps every case large enough to mean something and labelled on both sides", () => {
    for (const group of ["heavyCommand", "waitingOnOwner"] as const) {
      const labels = items.filter((item) => item.group === group).map((item) => item.gold.kind === "yesno" && item.gold.yes);
      expect(labels.filter(Boolean).length).toBeGreaterThanOrEqual(30);
      expect(labels.filter((label) => !label).length).toBeGreaterThanOrEqual(30);
    }
    expect(items.filter((item) => item.group === "dogRanking")).toHaveLength(40);
    expect(items.filter((item) => item.group === "roomRouting")).toHaveLength(53);
  });

  it("routes a room message to the one member it names, else to the first member", () => {
    const members = [{ id: "maya", name: "Maya" }, { id: "theo", name: "Theo" }];
    expect(ruleRoomResponder("@Theo the navbar", members)).toBe("theo");
    expect(ruleRoomResponder("the navbar is broken", members)).toBe("maya");
    expect(ruleRoomResponder("Maya and Theo, both of you", members)).toBe("maya");
  });

  it("reads a closing question or a request to act as waiting on the owner", () => {
    expect(ruleWaitingOnOwner("Should I delete the old branch, or keep it?")).toBe(true);
    expect(ruleWaitingOnOwner("Say go and I will publish it.")).toBe(true);
    expect(ruleWaitingOnOwner("Done. The pull request is merged.")).toBe(false);
  });

  it("grades a yes or no answer by the side it takes and a choice by the accepted set", () => {
    const heavy = items.find((item) => item.group === "heavyCommand" && item.gold.kind === "yesno" && item.gold.yes)!;
    expect(gradeDecision(heavy, { answers: { answer: { type: "noul", noul: 0.9 } } })).toMatchObject({ ok: true, graded: { correct: true, confidence: 0.9 } });
    expect(gradeDecision(heavy, { answers: { answer: { type: "noul", noul: 0.2 } } })).toMatchObject({ ok: true, graded: { correct: false, confidence: 0.8 } });
    expect(gradeDecision(heavy, { answers: { answer: { type: "noul", noul: 1.4 } } })).toEqual({ ok: false });
    const ranked = items.find((item) => item.group === "dogRanking")!;
    const accepted = ranked.gold.kind === "choice" ? ranked.gold.accepted[0]! : "";
    const answer = { type: "choice", choice: accepted, probabilities: { [accepted]: 0.7, hound: accepted === "hound" ? 0 : 0.3 } };
    expect(gradeDecision(ranked, { answers: { answer } })).toMatchObject({ ok: true, graded: { correct: true, confidence: 0.7 }, reciprocalRank: 1 });
    expect(gradeDecision(ranked, { answers: { answer: { ...answer, choice: "nobody-offered" } } })).toEqual({ ok: false });
  });

  it("scores every rule on its own case", () => {
    const share = (group: string) => {
      const scored = items.filter((item) => item.group === group && item.gold.kind !== "unscored");
      return scored.filter((item) => ruleCorrect(item)).length / scored.length;
    };
    expect(share("heavyCommand")).toBe(1);
    expect(share("waitingOnOwner")).toBeGreaterThan(0.7);
    expect(share("roomRouting")).toBeLessThan(0.5);
  });
});

describe("typed extraction", () => {
  const fixture = extractionFixture();
  const nowMs = Date.parse(fixture.now);

  it("plans one request per text with the day the texts were written", () => {
    const calls = extractionCalls(fixture);
    expect(calls).toHaveLength(fixture.resets.length + fixture.shortTexts.length + fixture.computed.length);
    expect(calls.every((call) => call.body.reference_date === "2026-11-10")).toBe(true);
  });

  it("refuses an answer of the wrong type and keeps the span, the guess and the chance of nothing", () => {
    const answers = {
      reset_time: { type: "time", value: "15:00:00", guess: "15:00:00", p_null: 0.01, confidence: 0.99 },
      reset_date: { type: "date", value: null, guess: "2026-11-10", p_null: 0.8 },
      time_zone: { type: "text", value: "UTC", span: [4, 7], p_null: 0.1 },
      wait: { type: "duration", value: null, guess: 0, p_null: 0.99 },
    };
    const parsed = parseExtraction({ answers, state_text: "at  UTC", usage: { input_tokens: 490 } }, RESET_FIELDS);
    expect(parsed).toMatchObject({ ok: true, inputTokens: 490, answers: { reset_date: { value: null, guess: "2026-11-10", pNull: 0.8 }, time_zone: { span: [4, 7] } } });
    expect(parsed.ok && spanSupports(parsed.answers.time_zone!, parsed.stateText)).toBe(true);
    expect(parsed.ok && spanSupports({ ...parsed.answers.time_zone!, value: "PST" }, parsed.stateText)).toBe(false);
    expect(parseExtraction({ answers: { ...answers, wait: { type: "duration", value: "soon" } } }, RESET_FIELDS)).toEqual({ ok: false });
    expect(parseExtraction({ answers: { reset_time: answers.reset_time } }, RESET_FIELDS)).toEqual({ ok: false });
    expect(parseExtraction("nothing", RESET_FIELDS)).toEqual({ ok: false });
  });

  it("reads clock times and dates in the forms the model returns", () => {
    expect(clockTime("15:00:00")).toBe("15:00");
    expect(clockTime("9:05 pm")).toBe("21:05");
    expect(clockTime("2026-11-10T07:30:00")).toBe("07:30");
    expect(clockTime("25:00")).toBeNull();
    expect(clockTime(null)).toBeNull();
    expect(calendarDate("2026-11-12T09:00:00")).toBe("2026-11-12");
    expect(calendarDate("next week")).toBeNull();
  });

  it("puts a reset on the next day when its clock time has passed, whatever date came with it", () => {
    const zone = "America/Los_Angeles";
    expect(wallClockIn(zone, nowMs)).toBe("2026-11-10T12:00");
    expect(resetWallClock({ time: "15:00", date: null, waitSeconds: null }, zone, nowMs)).toBe("2026-11-10T15:00");
    expect(resetWallClock({ time: "08:00", date: null, waitSeconds: null }, zone, nowMs)).toBe("2026-11-11T08:00");
    expect(resetWallClock({ time: "08:00", date: "2026-11-10", waitSeconds: null }, zone, nowMs)).toBe("2026-11-11T08:00");
    expect(resetWallClock({ time: "09:00", date: "2026-11-12", waitSeconds: null }, zone, nowMs)).toBe("2026-11-12T09:00");
    expect(resetWallClock({ time: null, date: null, waitSeconds: 8_100 }, zone, nowMs)).toBe("2026-11-10T14:15");
    expect(resetWallClock({ time: "06:15", date: null, waitSeconds: null }, "Asia/Tokyo", nowMs)).toBe("2026-11-11T06:15");
    expect(resetWallClock({ time: null, date: "2026-11-12", waitSeconds: null }, zone, nowMs)).toBeNull();
  });

  it("agrees with every reset the fixture expects when given the labelled parts", () => {
    for (const item of fixture.resets) {
      expect(resetWallClock({ time: item.time, date: item.date, waitSeconds: item.waitSeconds }, item.zoneId, nowMs), item.id).toBe(item.local);
    }
  });

  it("applies the shipped reset rule and a plain money and date rule to the same texts", () => {
    process.env.TZ = fixture.homeZone;
    const first = fixture.resets[0]!;
    expect(ruleResetWallClock(first, nowMs)).toBe(first.local);
    expect(ruleResetWallClock(fixture.resets.find((item) => item.text.startsWith("usage limit reached|"))!, nowMs)).toBe("2026-11-10T14:55");
    expect(ruleResetWallClock(fixture.resets.find((item) => item.waitSeconds !== null)!, nowMs)).toBeNull();
    expect(ruleShortText("Invoice INV-204 is due March 3, 2027 for $1,240.50.", 2026)).toEqual({ amount: 1240.5, date: "2027-03-03" });
    expect(ruleShortText("Paid 45 EUR on 12 January 2026.", 2026)).toEqual({ amount: 45, date: "2026-01-12" });
    expect(ruleShortText("Thanks for the update, talk soon.", 2026)).toEqual({ amount: null, date: null });
  });
});

describe("scoring receipts", () => {
  it("scores answers, failures and invalid answers apart, and renders every table", () => {
    const items = decisionItems();
    const heavy = items.filter((item) => item.group === "heavyCommand").slice(0, 4);
    const receipt = (item: string, extra: Partial<Receipt>): Receipt => ({
      id: `clef:heavyCommand:${item}`, group: "heavyCommand", model: "clef", item, target: "test", at: "2026-11-10T00:00:00.000Z", latencyMs: 300, ok: true, ...extra,
    });
    const yes = { model: "clef", answers: { answer: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 400, output_tokens: 0 } };
    const results = scoreAll([
      receipt(heavy[0]!.id, { result: yes }),
      receipt(heavy[1]!.id, { result: { ...yes, answers: { answer: { type: "noul", noul: 0.1 } } }, latencyMs: 1_900 }),
      receipt(heavy[2]!.id, { ok: false, error: "timeout", latencyMs: 20_000 }),
      receipt(heavy[3]!.id, { result: { answers: {} } }),
    ]);
    const score = results.decisions[0]!;
    expect(score).toMatchObject({ case: "heavyCommand", model: "clef", asked: 4, failed: 1, invalid: 1, scored: 2, accuracy: 0.5, failures: { timeout: 1 } });
    expect(score.latency).toMatchObject({ count: 3, overBudget: 1 });
    expect(score.dollarsPerThousand).toBeCloseTo(0.096);
    expect(results.rules.map((rule) => rule.case)).toEqual(["roomRouting", "heavyCommand", "waitingOnOwner", "dogRanking"]);
    expect(renderMarkdown(results)).toContain("| heavyCommand | clef | test | 2 | 50.0% |");
  });
});
