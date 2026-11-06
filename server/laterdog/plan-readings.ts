export interface LiveWindow {
  usedPercent: number;
  resetsAt: string | null;
}

export interface LiveReading {
  at: number;
  fiveHour?: LiveWindow;
  weekly?: LiveWindow;
}

const readings = new Map<string, LiveReading>();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function liveWindow(value: unknown): LiveWindow | undefined {
  const fields = record(value);
  const utilization = fields?.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined;
  const seconds = fields!.resetsAt;
  const resetsAt = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds >= 1e12 ? seconds : seconds * 1000).toISOString()
    : null;
  return { usedPercent: Math.min(100, Math.max(0, Math.round(utilization * 1000) / 10)), resetsAt };
}

export function claudeLiveReading(info: unknown, now: number = Date.now()): LiveReading | null {
  const windows = record(record(info)?.unifiedWindows);
  if (!windows) return null;
  const fiveHour = liveWindow(windows.five_hour);
  const weekly = liveWindow(windows.seven_day);
  if (!fiveHour && !weekly) return null;
  return { at: now, ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}

export function noteLiveReading(instanceId: string, reading: LiveReading | null): void {
  if (!instanceId || !reading) return;
  const known = readings.get(instanceId);
  if (known && known.at > reading.at) return;
  readings.set(instanceId, { at: reading.at, fiveHour: reading.fiveHour ?? known?.fiveHour, weekly: reading.weekly ?? known?.weekly });
}

export function liveReading(instanceId: string): LiveReading | undefined {
  return readings.get(instanceId);
}

export function clearLiveReadings(): void {
  readings.clear();
}
