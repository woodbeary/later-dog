export type IncidentKind = "failed" | "stalled";

export interface IncidentBot {
  id: string;
  name: string;
}

export interface Incident {
  kind: IncidentKind;
  bot: IncidentBot;
  threadId: string;
  title?: string | null;
  room?: string | null;
  detail: string;
}

export const INCIDENT_HARD_LIMIT = 5;
export const INCIDENT_WINDOW_MS = 60 * 60_000;

export interface IncidentCount {
  muted: boolean;
}

export class IncidentLedger {
  private readonly at = new Map<string, number[]>();
  private readonly options: { now?: () => number; windowMs?: number; hardLimit?: number };

  constructor(options: { now?: () => number; windowMs?: number; hardLimit?: number } = {}) {
    this.options = options;
  }

  note(threadId: string): IncidentCount {
    const now = this.options.now?.() ?? Date.now();
    const windowMs = this.options.windowMs ?? INCIDENT_WINDOW_MS;
    const recent = (this.at.get(threadId) ?? []).filter((time) => now - time < windowMs);
    recent.push(now);
    this.at.set(threadId, recent);
    return { muted: recent.length > (this.options.hardLimit ?? INCIDENT_HARD_LIMIT) };
  }
}

const fold = (text: string, max: number): string => {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

function whatHappened(incident: Incident): string {
  const where = incident.room ? `in the room "${incident.room}"` : incident.title ? `in its thread #${fold(incident.title, 60)}` : "in its main conversation";
  const detail = incident.detail ? `: "${fold(incident.detail, 240)}"` : "";
  switch (incident.kind) {
    case "stalled":
      return `${incident.bot.name}'s run ${where} stopped after showing no activity${detail}`;
    default:
      return `${incident.bot.name}'s run ${where} failed${detail}`;
  }
}

export function incidentChip(incident: Incident): string {
  return `Incident: ${whatHappened(incident)}`;
}
