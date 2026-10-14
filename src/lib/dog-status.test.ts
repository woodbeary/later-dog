import { describe, expect, it } from "vitest";

import { dogStatusKind, sendInFlight } from "./dog-status";

describe("the dot that says what a dog is doing", () => {
  it("asks for you before anything else, then shows work, then waits on teammates, then queued", () => {
    expect(dogStatusKind({ waiting: true, working: true, teammates: true, queued: true })).toBe("waiting");
    expect(dogStatusKind({ waiting: false, working: true, teammates: true, queued: true })).toBe("working");
    expect(dogStatusKind({ waiting: false, working: false, teammates: true, queued: true })).toBe("teammates");
    expect(dogStatusKind({ waiting: false, working: false, queued: true })).toBe("queued");
    expect(dogStatusKind({ waiting: false, working: false })).toBeNull();
  });

  it("counts a message that is still on its way out as work", () => {
    expect(sendInFlight([{ id: "a", role: "bot" }, { id: "optimistic-1", role: "user" }])).toBe(true);
    expect(sendInFlight([{ id: "optimistic-1", role: "user" }, { id: "a", role: "bot" }])).toBe(false);
    expect(sendInFlight([{ id: "u1", role: "user" }])).toBe(false);
    expect(sendInFlight([])).toBe(false);
  });
});
