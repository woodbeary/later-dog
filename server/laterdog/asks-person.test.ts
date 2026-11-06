import { describe, expect, it } from "vitest";
import { personAsk } from "./asks-person.ts";

describe("a teammate's result that asks the owner to decide", () => {
  it("finds the sentence that asks, as one short line", () => {
    const result = "I'm still blocked on plan usage. Nothing has been measured yet.\n\nI still need Jacob's decision: give this dog an account with weekly headroom, or the measurement waits until Saturday.";
    expect(personAsk(result, "Jacob")).toBe("I still need Jacob's decision: give this dog an account with weekly headroom, or the measurement waits until Saturday.");
    expect(personAsk("Should I ship it to beta now?", "Jacob")).toBe("Should I ship it to beta now?");
    expect(personAsk("Waiting on you to pick a plan.", "Jacob")).toBe("Waiting on you to pick a plan.");
  });

  it("leaves an ordinary report alone", () => {
    expect(personAsk("Done. Committed as abc123 and pushed to main.", "Jacob")).toBeNull();
    expect(personAsk("I need Rio's decision first.", "Jacob")).toBeNull();
    expect(personAsk("", "Jacob")).toBeNull();
    expect(personAsk(undefined, "Jacob")).toBeNull();
  });
});
