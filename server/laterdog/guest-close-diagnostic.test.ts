import { expect, it } from "vitest";
import { GuestCloseDiagnostic } from "./guest-close-diagnostic.ts";
it("records only a classified bounded cause across split or oversized stderr frames", () => {
  const d = new GuestCloseDiagnostic();
  d.receive(Buffer.from("fixture secret shown in vendor content ERR_MOD"));
  d.receive(Buffer.from("ULE_NOT_FOUND " + "/private/unrelated"));
  expect(d.category).toBe("module-missing");
  const huge = new GuestCloseDiagnostic();
  huge.receive("ignored".repeat(10000) + "permission denied /fixture-only");
  expect(huge.category).toBe("permission");
  const unknown = new GuestCloseDiagnostic();
  unknown.receive("Bearer fixture-secret");
  expect(unknown.category).toBe("unclassified");
});
