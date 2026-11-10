import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";

const count = z.number().finite().nonnegative();
const snapshot = z.object({
  seconds: count,
  renders: z.array(z.object({ name: z.string().max(80), count, perSecond: count }).strict()).max(100),
  events: count,
  eventsPerSecond: count,
  framesDropped: count,
  longestStallMs: count,
  heapMB: count.nullable(),
  timings: z.array(z.object({ name: z.string().max(80), count, totalMs: count, longestMs: count }).strict()).max(40).optional(),
}).strict();

export const phonePerformanceReport = z.object({
  version: z.literal(1),
  at: z.number().finite().positive(),
  build: z.string().max(40).optional(),
  update: z.string().max(80).optional(),
  os: z.string().max(40).optional(),
  dogs: z.number().int().min(1).max(100),
  passes: z.array(z.object({
    lean: z.boolean(),
    switches: count,
    switching: snapshot,
    idle: snapshot,
    droppedDeltas: count,
    receivedDeltas: count.optional(),
    watchedDeltas: count.optional(),
    serverWatch: z.boolean().optional(),
  }).strict()).min(1).max(2),
}).strict();

export type PhonePerformanceReport = z.infer<typeof phonePerformanceReport>;
export type KeptPhonePerformance = PhonePerformanceReport & { receivedAt: number };

export class PhonePerformance {
  private readonly file: string;
  private readonly limit: number;

  constructor(file: string, limit = 50) {
    this.file = file;
    this.limit = limit;
  }

  recent(): KeptPhonePerformance[] {
    try {
      const reports: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(reports) ? reports as KeptPhonePerformance[] : [];
    } catch {
      return [];
    }
  }

  record(report: PhonePerformanceReport, receivedAt = Date.now()): void {
    writeFileAtomic(this.file, JSON.stringify([...this.recent(), { ...report, receivedAt }].slice(-this.limit)), { mode: 0o600 });
  }
}
