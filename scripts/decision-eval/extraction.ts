import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseResetWords, resetInstant } from "../../server/laterdog/usage-limit.ts";
import type { PlannedCall } from "./cases.ts";

export const EXTRACTION_MODEL = "clairic";
export const EXTRACTION_CASES = ["resetTime", "shortText", "computed"] as const;
export type ExtractionCase = (typeof EXTRACTION_CASES)[number];

type FieldType = "text" | "number" | "date" | "time" | "datetime" | "duration" | "estimate";
export interface FieldSpec {
  type: FieldType;
  instructions?: string;
  unit?: string;
  integer?: boolean;
  decimals?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface ResetItem {
  id: string;
  text: string;
  time: string | null;
  date: string | null;
  zone: string | null;
  zoneId: string;
  waitSeconds: number | null;
  local: string | null;
}
export interface ShortTextItem { id: string; text: string; amount: number | null; date: string | null }
export interface ComputedItem { id: string; text: string; field: FieldSpec; gold: string | number; estimate?: { min: number; max: number; step: number } }
export interface ExtractionFixture { now: string; homeZone: string; resets: ResetItem[]; shortTexts: ShortTextItem[]; computed: ComputedItem[] }

export const RESET_FIELDS: Record<string, FieldSpec> = {
  reset_time: { type: "time", instructions: "The clock time at which the usage limit resets or the person can try again. Null when the message gives no such time." },
  reset_date: { type: "date", instructions: "The calendar date of that reset, only when the message states or implies a day. Null when it gives only a clock time." },
  time_zone: { type: "text", instructions: "The time zone named for the reset time." },
  wait: { type: "duration", unit: "seconds", integer: true, instructions: "How long until the limit resets, only when the message gives a wait instead of a clock time." },
};

export const SHORT_TEXT_FIELDS: Record<string, FieldSpec> = {
  amount: { type: "number", decimals: 2, instructions: "The amount of money stated. Null when no money amount is given." },
  date: { type: "date", instructions: "The calendar date stated. Null when no date is given." },
};

export function extractionFixture(): ExtractionFixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "extraction.json"), "utf8")) as ExtractionFixture;
}

export function extractionCalls(fixture: ExtractionFixture): PlannedCall[] {
  const referenceDate = fixture.now.slice(0, 10);
  const call = (group: ExtractionCase, item: string, state: string, fields: Record<string, FieldSpec>): PlannedCall => ({
    id: `${EXTRACTION_MODEL}:${group}:${item}`,
    group,
    model: EXTRACTION_MODEL,
    item,
    body: { model: EXTRACTION_MODEL, state, fields, reference_date: referenceDate, options: { return_state_text: true } },
  });
  return [
    ...fixture.resets.map((item) => call("resetTime", item.id, item.text, RESET_FIELDS)),
    ...fixture.shortTexts.map((item) => call("shortText", item.id, item.text, SHORT_TEXT_FIELDS)),
    ...fixture.computed.map((item) => call("computed", item.id, item.text, {
      value: item.field,
      ...(item.estimate ? { estimated: { type: "estimate" as const, instructions: item.field.instructions, ...item.estimate } } : {}),
    })),
  ];
}

export interface ExtractedValue {
  value: string | number | null;
  guess: string | number | null;
  pNull: number | null;
  confidence: number | null;
  span: [number, number] | null;
  p10: number | null;
  p90: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const probability = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function parseExtraction(
  result: unknown,
  fields: Readonly<Record<string, FieldSpec>>,
): { ok: true; answers: Record<string, ExtractedValue>; stateText: string | null; inputTokens: number | null } | { ok: false } {
  if (!isRecord(result) || !isRecord(result.answers)) return { ok: false };
  const answers: Record<string, ExtractedValue> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const raw = result.answers[name];
    if (!isRecord(raw) || !("value" in raw)) return { ok: false };
    const value = raw.value;
    const numeric = spec.type === "number" || spec.type === "duration" || spec.type === "estimate";
    if (value !== null && (numeric ? finite(value) === null : typeof value !== "string")) return { ok: false };
    const span = Array.isArray(raw.span) && raw.span.length === 2 && raw.span.every((offset) => Number.isInteger(offset) && (offset as number) >= 0)
      ? (raw.span as [number, number])
      : null;
    const guess = typeof raw.guess === "string" || finite(raw.guess) !== null ? (raw.guess as string | number) : null;
    answers[name] = {
      value: value as string | number | null,
      guess,
      pNull: probability(raw.p_null),
      confidence: probability(raw.confidence),
      span,
      p10: finite(raw.p10),
      p90: finite(raw.p90),
    };
  }
  const usage = isRecord(result.usage) ? finite(result.usage.input_tokens) : null;
  return { ok: true, answers, stateText: typeof result.state_text === "string" ? result.state_text : null, inputTokens: usage };
}

export function spanSupports(answer: ExtractedValue, stateText: string | null): boolean | null {
  if (answer.value === null || typeof answer.value !== "string" || !answer.span || stateText === null) return null;
  return stateText.slice(answer.span[0], answer.span[1]).trim() === answer.value.trim();
}

export function wallClockIn(zone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(instantMs));
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}T${field("hour")}:${field("minute")}`;
}

export function clockTime(value: string | number | null): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(am|pm)?$/i.exec(value.trim()) ?? /T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function calendarDate(value: string | number | null): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? value.trim().slice(0, 10) : null;
}

function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function resetWallClock(
  parts: { time: string | null; date: string | null; waitSeconds: number | null },
  zone: string,
  nowMs: number,
): string | null {
  if (parts.waitSeconds !== null && parts.waitSeconds >= 0) return wallClockIn(zone, nowMs + parts.waitSeconds * 1000);
  if (!parts.time) return null;
  const nowWall = wallClockIn(zone, nowMs);
  if (parts.date) return `${parts.date}T${parts.time}`;
  const today = `${nowWall.slice(0, 10)}T${parts.time}`;
  return today > nowWall ? today : `${dayAfter(nowWall.slice(0, 10))}T${parts.time}`;
}

export function ruleResetWallClock(item: ResetItem, nowMs: number): string | null {
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(item.text)?.[1];
  const instant = (legacy ? resetInstant(Number(legacy), nowMs) : undefined) ?? parseResetWords(item.text, nowMs);
  return instant ? wallClockIn(item.zoneId, Date.parse(instant)) : null;
}

const MONEY = /(?:[$£€]\s?(\d[\d,]*(?:\.\d+)?))|(?:(\d[\d,]*(?:\.\d+)?)\s?(?:usd|eur|dollars?|euros?|€|£))|(?:(?:usd|eur)\s?(\d[\d,]*(?:\.\d+)?))/i;
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const MONTH_FIRST = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "i");
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}(?:,?\\s+(\\d{4}))?`, "i");

const isoDate = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const monthNumber = (name: string) => MONTH_NAMES.findIndex((month) => month.startsWith(name.slice(0, 3).toLowerCase())) + 1;

export function ruleShortText(text: string, referenceYear: number): { amount: number | null; date: string | null } {
  const money = MONEY.exec(text);
  const digits = money?.[1] ?? money?.[2] ?? money?.[3];
  const amount = digits ? Number(digits.replace(/,/g, "")) : null;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return { amount, date: iso[0] };
  const dayFirst = DAY_FIRST.exec(text);
  if (dayFirst) return { amount, date: isoDate(Number(dayFirst[3] ?? referenceYear), monthNumber(dayFirst[2]!), Number(dayFirst[1])) };
  const monthFirst = MONTH_FIRST.exec(text);
  if (monthFirst) return { amount, date: isoDate(Number(monthFirst[3] ?? referenceYear), monthNumber(monthFirst[1]!), Number(monthFirst[2])) };
  return { amount, date: null };
}

export function sameNumber(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= 0.005 + Math.abs(b) * 1e-9;
}
