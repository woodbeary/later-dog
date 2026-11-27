import { describe, expect, it } from "vitest";
import { DATA_OPERATION_MS, METADATA_OPERATION_MS, operationDeadline, withOperationDeadline } from "./work-folder-op-deadline.ts";

describe("bounding each working folder operation", () => {
  it("answers a stalled computer with ETIMEDOUT instead of holding the call", async () => {
    const started = Date.now();
    await expect(withOperationDeadline("getattr", new Promise(() => {}), 40)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("passes an answer through unchanged", async () => {
    await expect(withOperationDeadline("read", Promise.resolve({ ok: true }), 40)).resolves.toEqual({ ok: true });
  });

  it("gives data operations longer than metadata, and both answer before the mount client gives up", () => {
    expect(operationDeadline("getattr")).toBe(METADATA_OPERATION_MS);
    expect(operationDeadline("write")).toBe(DATA_OPERATION_MS);
    expect(METADATA_OPERATION_MS).toBeLessThan(15_000);
    expect(DATA_OPERATION_MS).toBeLessThan(60_000);
  });
});
