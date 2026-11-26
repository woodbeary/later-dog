import { describe, expect, it } from "vitest";
import type { WireMessage } from "../../shared/wire.ts";
import { personInRequest } from "./person-in-request.ts";

const row = (id: string, extra: Partial<WireMessage>): WireMessage => ({ id, role: "bot", kind: "text", text: id, at: 0, ...extra });
const request = row("request", { roomRequest: { id: "req-1", phase: "request" }, from: { botId: "sol", name: "Sol Lead", color: "purple" } });
const person = row("person", { role: "user", text: "Did it ship?", steered: true });
const folded = row("folded", { role: "user", text: "And the phone?", steered: true, queueId: "q-1" });
const peer = row("peer", { role: "user", text: "From Scout", peerAsk: { botId: "scout", name: "Scout" } });
const progress = row("progress", { roomRequest: { id: "req-1", phase: "reply" } });

describe("whether the person wrote into a teammate's request", () => {
  it("counts a message the person steered or folded in after the request arrived", () => {
    expect(personInRequest([request, progress, person], "req-1")).toBe(true);
    expect(personInRequest([request, folded], "req-1")).toBe(true);
  });

  it("ignores what the person said before the request and what another dog asked", () => {
    expect(personInRequest([person, request, progress], "req-1")).toBe(false);
    expect(personInRequest([request, peer], "req-1")).toBe(false);
  });

  it("counts nothing for a request it cannot find", () => {
    expect(personInRequest([person], "req-1")).toBe(false);
    expect(personInRequest([request, person], "req-2")).toBe(false);
  });
});
