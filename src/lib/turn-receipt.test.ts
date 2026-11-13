import { describe, expect, it } from "vitest";
import { receiptLine } from "./turn-receipt";

const instances = [
  { instanceId: "work", displayName: "Work account", driverKind: "fake", models: { default: "large", options: [{ id: "large", label: "Large" }, { id: "mini", label: "Small" }] } },
  { instanceId: "home", displayName: "Home account", driverKind: "fake", models: { default: "large", options: [{ id: "large", label: "Large" }] } },
];

describe("the line under a finished turn", () => {
  it("names the account, model and effort that ran", () => {
    expect(receiptLine({ account: "Work account", instanceId: "work", model: "large", effort: "high" }, instances)).toBe("Ran on Work account · Large · High");
  });

  it("adds what was selected only when it differs", () => {
    expect(receiptLine({ account: "Home account", instanceId: "home", model: "large", effort: "medium",
      selected: { instanceId: "work", model: "mini", effort: "high" } }, instances))
      .toBe("Ran on Home account · Large · Medium · selected Work account · Small · High");
  });

  it("prefers the engine's own model name and works without an account", () => {
    expect(receiptLine({ instanceId: "work", model: "large", reportedModel: "large-2026-10" }, instances)).toBe("Ran on large-2026-10");
  });

  it("shows nothing for a message from before receipts", () => {
    expect(receiptLine(undefined, instances)).toBeNull();
  });
});
