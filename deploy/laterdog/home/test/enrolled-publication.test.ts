import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { enrolledPublication, validateCutoverBinding } from "../migration/cutover-publication.mjs";

it("publishes only the approved proposal through a held source and verifies its durable serialized acknowledgment", async () => {
  const machine = "h" + "0".repeat(24), nonce = "1".repeat(64), image = "2".repeat(64);
  const authority = { service: "dedicated-home", accountId: "fixture", machineId: machine, nonce, image, verification: "3".repeat(64), baselineManifest: "4".repeat(64), candidate: "5".repeat(64) };
  expect(() => validateCutoverBinding({ services: [{ binding: "CUTOVER", service: "other", entrypoint: "WorkFolderMigrationApi", remote: true }] }, authority)).toThrow();
  const placement = { mode: "folders", verification: authority.verification, baselineManifest: authority.baselineManifest, previous: null };
  const json = JSON.stringify(placement), revision = createHash("sha256").update(json).digest("hex");
  let installed = "", calls = 0, held = true, retired = false;
  const store = { async get(key: string) { if (key.endsWith("/cutover-enrollment")) return held ? new Response(JSON.stringify({ v: 1, lease: nonce, machineId: machine, image, ...(retired ? { retired: true, retiredRevision: revision } : {}) })) : null; return installed ? new Response(installed) : null; } };
  const service = { async cutover(account: string, given: string, input: unknown) { expect([account, given, input]).toEqual(["fixture", nonce, { op: "publish", placement, precondition: { "if-none-match": "*" }, candidate: authority.candidate }]); calls++; return { phase: "committed", revision }; } };
  const request = (value = placement) => new Request("http://state.r2/work-folders/placement", { method: "PUT", headers: { "if-none-match": "*" }, body: JSON.stringify(value) });
  expect((await enrolledPublication(request(), store, "a".repeat(64), service, null))?.status).toBe(423);
  expect((await enrolledPublication(request({ ...placement, baselineManifest: "0".repeat(64) }), store, "a".repeat(64), service, authority))?.status).toBe(423);
  expect(calls).toBe(0);
  expect((await enrolledPublication(request(), store, "a".repeat(64), service, authority))?.status).toBe(423);
  installed = json;
  expect((await enrolledPublication(request(), store, "a".repeat(64), service, authority))?.status).toBe(200);
  expect(calls).toBe(2);
  retired = true;
  expect((await enrolledPublication(request(), store, "a".repeat(64), service, authority))?.status).toBe(200);
  expect(await enrolledPublication(request(), store, "a".repeat(64), service, null)).toBeNull();
  expect(calls).toBe(2);
  held = false;
  expect((await enrolledPublication(request(), store, "a".repeat(64), service, authority))?.status).toBe(423);
  expect(await enrolledPublication(request(), store, "a".repeat(64), service, null)).toBeNull();
});
