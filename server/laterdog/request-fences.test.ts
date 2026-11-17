import { describe, expect, it } from "vitest";
import type { WireMessage as Message } from "../../shared/wire.ts";
import { ENDED_REQUEST, endedRequestIds } from "./request-fences.ts";

const message = (id: string, fields: Partial<Message>): Message => ({ id, at: 1, role: "user", kind: "text", text: id, ...fields }) as Message;

describe("requests that have ended", () => {
  it("are every request still marked as going except the one the chat is working on now", () => {
    const messages = [
      message("superseded", { requestPending: true }),
      message("stopped", { requestPending: true, requestCancelled: true }),
      message("settled", { requestPending: false }),
      message("reply", { role: "bot", requestPending: true }),
      message("live", { requestPending: true }),
    ];
    expect(endedRequestIds(messages, "live")).toEqual(["superseded", "stopped"]);
    expect(endedRequestIds(messages, undefined)).toEqual(["superseded", "stopped", "live"]);
  });

  it("are cleared without being reported as settled", () => {
    expect(ENDED_REQUEST).toEqual({ requestPending: false, requestCancelled: true });
  });
});
