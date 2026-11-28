import type { SignedCapabilityClaims } from "../../../../shared/signed-capability.ts";
import { DOG_CHAT, validObjectId, type InboxRequest, type RoutinesRequest } from "../../../../shared/dog-object-protocol.ts";
import { validObjectRoutine, type DogRoutinesPort } from "./dog-routines.ts";
import type { DogInboxPort } from "./dog-inbox.ts";

export type DogObjectPort = DogRoutinesPort & DogInboxPort;

function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= 500 && value.every(validObjectId) ? value : null;
}

export async function serveRoutines(body: Record<string, unknown>, claims: SignedCapabilityClaims, dog: DogObjectPort): Promise<Response> {
  if (claims.chat !== DOG_CHAT) return answer(403, { error: "dog_capability_required" });
  const request = body as unknown as RoutinesRequest;
  switch (request.op) {
    case "put": {
      if (!Array.isArray(request.routines) || !request.routines.every(validObjectRoutine) || typeof request.timeZone !== "string") {
        return answer(400, { error: "bad_routines" });
      }
      return answer(200, { ...(await dog.putRoutines(request.timeZone, request.routines)) });
    }
    case "claim":
      return answer(200, { ...(await dog.claimRoutines()) });
    case "settle": {
      if (!validObjectId(request.id) || !validObjectId(request.runId) || (request.state !== "started" && request.state !== "settled")) {
        return answer(400, { error: "bad_settle" });
      }
      const settled = await dog.settleRoutine(request.id, request.state, request.runId);
      return settled ? answer(200, { ...settled }) : answer(409, { error: "occurrence_unknown" });
    }
    case "export":
      return answer(200, { ...(await dog.exportRoutines()) });
    default:
      return answer(400, { error: "unknown_op" });
  }
}

export async function serveInbox(body: Record<string, unknown>, claims: SignedCapabilityClaims, dogFor: (dog: string) => DogObjectPort): Promise<Response> {
  const request = body as unknown as InboxRequest & { dog?: unknown };
  switch (request.op) {
    case "put": {
      if (!validObjectId(request.dog) || !request.letter || request.letter.from !== claims.dog) return answer(400, { error: "bad_letter" });
      const letter = await dogFor(request.dog).inboxPut(request.letter);
      return letter ? answer(200, { ok: true, letter }) : answer(409, { error: "letter_refused" });
    }
    case "status": {
      const wanted = ids(request.clientIds);
      if (!validObjectId(request.dog) || !wanted) return answer(400, { error: "bad_status" });
      return answer(200, { ok: true, states: await dogFor(request.dog).inboxStatus(wanted) });
    }
    case "pull": {
      if (claims.chat !== DOG_CHAT) return answer(403, { error: "dog_capability_required" });
      const after = typeof request.after === "number" ? request.after : 0;
      const limit = typeof request.limit === "number" ? request.limit : 50;
      return answer(200, { ok: true, letters: await dogFor(claims.dog).inboxPull(after, limit) });
    }
    case "ack": {
      const acked = ids(request.clientIds);
      if (claims.chat !== DOG_CHAT) return answer(403, { error: "dog_capability_required" });
      if (!acked) return answer(400, { error: "bad_ack" });
      return answer(200, { ok: true, acked: await dogFor(claims.dog).inboxAck(acked) });
    }
    default:
      return answer(400, { error: "unknown_op" });
  }
}
