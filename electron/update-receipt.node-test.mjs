import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clearUpdateReceipt, takeUpdateReceipt, updateReceiptOutcome, writeUpdateReceipt } from "./update-receipt.mjs";

function folder(t) {
  const userData = mkdtempSync(join(tmpdir(), "laterdog-update-receipt-"));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  return userData;
}

const NOW = Date.parse("2026-10-18T12:00:00Z");

test("a restart that came back on the new version reads as updated, once", (t) => {
  const userData = folder(t);
  assert.equal(writeUpdateReceipt(userData, { from: "0.3.42", target: "0.3.43", requestedAt: NOW }), true);
  const file = join(userData, "update-receipt.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { from: "0.3.42", target: "0.3.43", requestedAt: NOW });
  assert.equal(statSync(file).mode & 0o777, 0o600);

  assert.deepEqual(takeUpdateReceipt(userData, { currentVersion: "0.3.43", now: NOW + 60_000 }), { outcome: "updated", version: "0.3.43" });
  assert.equal(existsSync(file), false);
  assert.equal(takeUpdateReceipt(userData, { currentVersion: "0.3.43", now: NOW + 60_000 }), null);
});

test("a restart that came back on the old version reads as unfinished, once", (t) => {
  const userData = folder(t);
  writeUpdateReceipt(userData, { from: "0.3.42", target: "0.3.43", requestedAt: NOW });
  assert.deepEqual(takeUpdateReceipt(userData, { currentVersion: "0.3.42", now: NOW + 60_000 }), { outcome: "unfinished", version: "0.3.43" });
  assert.equal(takeUpdateReceipt(userData, { currentVersion: "0.3.42", now: NOW + 60_000 }), null);
});

test("a stale, foreign or damaged receipt says nothing and is cleared", (t) => {
  const userData = folder(t);
  const file = join(userData, "update-receipt.json");
  writeUpdateReceipt(userData, { from: "0.3.42", target: "0.3.43", requestedAt: NOW - 8 * 24 * 60 * 60 * 1000 });
  assert.equal(takeUpdateReceipt(userData, { currentVersion: "0.3.42", now: NOW }), null);
  assert.equal(existsSync(file), false);

  writeUpdateReceipt(userData, { from: "0.3.42", target: "0.3.43", requestedAt: NOW });
  assert.equal(takeUpdateReceipt(userData, { currentVersion: "0.3.50", now: NOW }), null);
  assert.equal(existsSync(file), false);

  writeFileSync(file, "{ not json");
  assert.equal(takeUpdateReceipt(userData, { currentVersion: "0.3.42", now: NOW }), null);
  assert.equal(existsSync(file), false);

  assert.equal(takeUpdateReceipt(userData, { currentVersion: "0.3.42", now: NOW }), null);
});

test("only a receipt naming two different plain versions and a real time counts", () => {
  const at = { currentVersion: "1.0.0", now: NOW };
  assert.equal(updateReceiptOutcome(null, at), null);
  assert.equal(updateReceiptOutcome({ from: "1.0.0", target: "1.0.0", requestedAt: NOW }, at), null);
  assert.equal(updateReceiptOutcome({ from: "1.0.0", target: 2, requestedAt: NOW }, at), null);
  assert.equal(updateReceiptOutcome({ from: "1.0.0", target: "2.0.0", requestedAt: "soon" }, at), null);
  assert.equal(updateReceiptOutcome({ from: "1.0.0", target: "2.0.0", requestedAt: NOW + 30 * 24 * 60 * 60 * 1000 }, at), null);
  assert.deepEqual(updateReceiptOutcome({ from: "1.0.0", target: "2.0.0", requestedAt: NOW }, at), { outcome: "unfinished", version: "2.0.0" });
});

test("clearing a receipt that is not there is harmless", (t) => {
  const userData = folder(t);
  assert.doesNotThrow(() => clearUpdateReceipt(userData));
  assert.equal(writeUpdateReceipt(join(userData, "missing", "deeper"), { from: "1", target: "2", requestedAt: NOW }), true);
});
