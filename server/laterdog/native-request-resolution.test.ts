import { expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { requestCardResolution } from "./native-request-resolution.ts";

const event: Extract<RuntimeEvent, { type: "request.resolved" }> = { type: "request.resolved", eventId: "event", threadId: "thread", provider: "codex", createdAt: "2026-10-16T20:00:00Z", requestId: "request", behavior: "deny", source: "system" };
const card: OptionCardData = { title: "Question", subtitle: "Which one?", options: ["A", "B"], requestType: "question", nativeActorId: "child", nativeActorLabel: "Researcher" };

it("closes externally resolved native questions without inventing a denial or an answer", () => {
  expect({ ...card, ...requestCardResolution(card, { ...event, resolvedExternally: true }) }).toMatchObject({ answered: "resolved", answeredText: "Resolved by Codex", dismissed: false, nativeActorId: "child", nativeActorLabel: "Researcher" });
  expect(requestCardResolution({ ...card, requestType: "permission" }, { ...event, resolvedExternally: true })).toMatchObject({ answered: "resolved", dismissed: false });
});

it("keeps normal persistent questions waiting through system cancellation and preserves explicit answers", () => {
  expect(requestCardResolution(card, event)).toBeUndefined();
  expect(requestCardResolution(card, { ...event, behavior: "answer", source: "user" })).toEqual({ answered: "answer", dismissed: false });
  expect(requestCardResolution({ ...card, requestType: "permission" }, event)).toEqual({ answered: "deny", dismissed: true });
});
