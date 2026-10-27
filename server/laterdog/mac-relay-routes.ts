import { z } from "zod";
import { MacRelayQueue } from "./mac-relay.ts";

const resultBody = z.object({ text: z.string().min(1).max(200_000) }).strict();
const failBody = z.object({ message: z.string().min(1).max(2000) }).strict();

export type MacRelayAuth = { botId: string } | null;

export function macRelayRoutes(queue: MacRelayQueue, authenticate: (bearer: string | undefined) => MacRelayAuth) {
  return {
    async nextJob(bearer: string | undefined): Promise<{ status: number; body: unknown }> {
      const auth = authenticate(bearer);
      if (!auth) return { status: 401, body: { error: "unknown or expired Mac relay session" } };
      const job = queue.nextJob(auth.botId);
      return { status: 200, body: { job } };
    },
    async completeJob(bearer: string | undefined, jobId: string, raw: unknown): Promise<{ status: number; body: unknown }> {
      const auth = authenticate(bearer);
      if (!auth) return { status: 401, body: { error: "unknown or expired Mac relay session" } };
      const parsed = resultBody.safeParse(raw);
      if (!parsed.success) return { status: 400, body: { error: "a relay result needs text" } };
      const done = queue.completeJob(jobId, parsed.data.text);
      return done ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "no such job, or it already timed out" } };
    },
    async failJob(bearer: string | undefined, jobId: string, raw: unknown): Promise<{ status: number; body: unknown }> {
      const auth = authenticate(bearer);
      if (!auth) return { status: 401, body: { error: "unknown or expired Mac relay session" } };
      const parsed = failBody.safeParse(raw);
      if (!parsed.success) return { status: 400, body: { error: "a relay failure needs a message" } };
      const done = queue.failJob(jobId, parsed.data.message);
      return done ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "no such job, or it already timed out" } };
    },
  };
}
