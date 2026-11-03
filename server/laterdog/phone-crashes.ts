import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";

export const PHONE_CRASHES_KEPT = 200;

export const phoneCrashReport = z.object({
  kind: z.enum(["error", "ended"]),
  at: z.number().finite().positive(),
  startedAt: z.number().finite().positive().optional(),
  build: z.string().max(40).optional(),
  update: z.string().max(80).optional(),
  os: z.string().max(40).optional(),
  message: z.string().max(2_000).optional(),
  stack: z.string().max(8_000).optional(),
  fatal: z.boolean().optional(),
}).strict();

export type PhoneCrashReport = z.infer<typeof phoneCrashReport>;
export type KeptPhoneCrash = PhoneCrashReport & { receivedAt: number };

function where(report: PhoneCrashReport): string {
  const parts = [report.build && `build ${report.build}`, report.update && `update ${report.update.slice(0, 8)}`].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export function phoneCrashLine(report: PhoneCrashReport): string {
  if (report.kind === "ended") {
    const ran = report.startedAt && report.at >= report.startedAt ? ` after ${Math.round((report.at - report.startedAt) / 1000)} s` : "";
    return `phone crash report: the app ended without closing${ran}${where(report)}${report.message ? `; its last error: ${report.message}` : ""}`;
  }
  return `phone crash report: ${report.fatal ? "fatal " : ""}error${where(report)}: ${report.message ?? "no message"}`;
}

export class PhoneCrashes {
  constructor(private readonly file: string, private readonly kept = PHONE_CRASHES_KEPT) {}

  recent(): KeptPhoneCrash[] {
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(saved) ? saved as KeptPhoneCrash[] : [];
    } catch {
      return [];
    }
  }

  record(report: PhoneCrashReport, receivedAt = Date.now()): KeptPhoneCrash {
    const kept = { ...report, receivedAt };
    writeFileAtomic(this.file, JSON.stringify([...this.recent(), kept].slice(-this.kept), null, 1), { mode: 0o600 });
    return kept;
  }
}
