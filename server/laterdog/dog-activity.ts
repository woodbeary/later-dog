export const ACTIVITY_DAYS = 30;
export const TURN_CAP_MS = 2 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export interface ActivityMessage {
  role: string;
  kind?: string;
  at: number;
}

export interface DayActivity {
  day: string;
  sent: number;
  replies: number;
  turns: number;
  workedSeconds: number;
}

export interface DogActivity {
  today: string;
  days: DayActivity[];
  totals: Omit<DayActivity, "day">;
}

export function dayKey(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function recentDays(now: number, count: number, timeZone?: string): string[] {
  const days: string[] = [];
  for (let at = now; days.length < count; at -= HOUR_MS) {
    const day = dayKey(at, timeZone);
    if (days[0] !== day) days.unshift(day);
  }
  return days;
}

export function dogActivity(input: {
  threads: readonly (readonly ActivityMessage[])[];
  turnTimes: readonly number[];
  now: number;
  days?: number;
  timeZone?: string;
}): DogActivity {
  const keys = recentDays(input.now, input.days ?? ACTIVITY_DAYS, input.timeZone);
  const byDay = new Map(keys.map((day) => [day, { day, sent: 0, replies: 0, turns: 0, workedSeconds: 0 }]));
  const on = (at: number) => byDay.get(dayKey(at, input.timeZone));
  for (const thread of input.threads) {
    let askedAt: number | null = null;
    let lastOutput: number | null = null;
    const settle = () => {
      if (askedAt === null || lastOutput === null || lastOutput <= askedAt) return;
      const day = on(askedAt);
      if (day) day.workedSeconds += Math.min(lastOutput - askedAt, TURN_CAP_MS) / 1000;
    };
    for (const message of [...thread].sort((a, b) => a.at - b.at)) {
      if (message.role === "user" && message.kind === "text") {
        settle();
        askedAt = message.at;
        lastOutput = null;
        const day = on(message.at);
        if (day) day.sent += 1;
      } else if (message.role === "bot") {
        if (message.kind === "text") {
          const day = on(message.at);
          if (day) day.replies += 1;
        }
        if (askedAt !== null) lastOutput = message.at;
      }
    }
    settle();
  }
  for (const at of input.turnTimes) {
    const day = on(at);
    if (day) day.turns += 1;
  }
  const days = [...byDay.values()].map((day) => ({ ...day, workedSeconds: Math.round(day.workedSeconds) }));
  const totals = days.reduce(
    (sum, day) => ({ sent: sum.sent + day.sent, replies: sum.replies + day.replies, turns: sum.turns + day.turns, workedSeconds: sum.workedSeconds + day.workedSeconds }),
    { sent: 0, replies: 0, turns: 0, workedSeconds: 0 },
  );
  return { today: keys[keys.length - 1]!, days, totals };
}
