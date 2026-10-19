import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { readOwnedJson } from "./owned-file.ts";

export const DOG_CREATE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_REQUESTS = 4_096;

const createIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
const requestSchema = z.object({ createId: createIdSchema, botId: z.string().min(1).max(120), createdAt: z.number().finite() });
const journalSchema = z.object({ version: z.literal(1), requests: z.array(requestSchema) });

type DogCreateRequest = z.infer<typeof requestSchema>;

export function parseCreateId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = createIdSchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error("createId must be a client-generated id"), { status: 400 });
  return parsed.data;
}

export function parseHello(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw Object.assign(new Error("hello must be true or false"), { status: 400 });
  return value;
}

export class DogCreateJournal {
  private requests: DogCreateRequest[] | null = null;
  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  private fresh(): DogCreateRequest[] {
    const since = this.now() - DOG_CREATE_RETENTION_MS;
    if (!this.requests) {
      const read = readOwnedJson(this.file, (raw) => {
        const parsed = journalSchema.safeParse(raw);
        return parsed.success ? parsed.data.requests : undefined;
      });
      this.requests = read.state === "ok" ? read.value : [];
    }
    this.requests = this.requests.filter((request) => request.createdAt > since);
    return this.requests;
  }

  find(createId: string): string | undefined {
    return this.fresh().find((request) => request.createId === createId)?.botId;
  }

  remember(createId: string, botId: string): void {
    const kept = this.fresh().filter((request) => request.createId !== createId);
    const next = [...kept, { createId, botId, createdAt: this.now() }].slice(-MAX_REQUESTS);
    this.requests = next;
    try {
      writeFileAtomic(this.file, `${JSON.stringify({ version: 1, requests: next }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[dog-create] could not save the create journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
