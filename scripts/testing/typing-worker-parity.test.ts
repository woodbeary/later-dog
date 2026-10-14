import { describe, expect, it } from "vitest";
import { completeInput, completeRequest, finishCompletion as workerFinish } from "../../deploy/laterdog/computers/src/complete.ts";
import { finishCompletion as appFinish, parseTypingRequest, typingModelInput } from "../../server/laterdog/typing-context.ts";

describe("the Worker and the app word the question the same way", () => {
  const request = { prefix: "Please fix", dog: "Rex", messages: [{ role: "dog" as const, text: "Two tests fail." }, { role: "person" as const, text: "ok" }], phrasing: ["Can you look at"] };

  it("builds the same model input", () => {
    const worker = completeRequest(request);
    const app = parseTypingRequest(request);
    if (!worker.ok || !app.ok) throw new Error("parse");
    expect(typingModelInput(app.request)).toEqual(completeInput(worker.request));
  });

  it("finishes the same completions", () => {
    for (const [prefix, raw] of [["Please fix ", "the failing tests"], ["Please fix", " the failing tests"], ["Done.", "Thanks"], ["Can you fi", "x the build\nmore"], ["a", "\"quoted words here\""], ["a", "w ".repeat(40)], ["a", "x".repeat(400)]] as const) {
      expect(appFinish(prefix, raw)).toBe(workerFinish(prefix, raw));
    }
  });
});
