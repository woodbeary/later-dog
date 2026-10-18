import fs from "node:fs";
import path from "node:path";

const RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const receiptFile = (userData) => path.join(userData, "update-receipt.json");

const plainVersion = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;

export function writeUpdateReceipt(userData, { from, target, requestedAt = Date.now() }) {
  const file = receiptFile(userData);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ from, target, requestedAt }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    return false;
  }
}

export function clearUpdateReceipt(userData) {
  try {
    fs.unlinkSync(receiptFile(userData));
  } catch {}
}

export function updateReceiptOutcome(receipt, { currentVersion, now = Date.now() }) {
  if (!receipt || !plainVersion(receipt.from) || !plainVersion(receipt.target) || receipt.from === receipt.target) return null;
  if (typeof receipt.requestedAt !== "number" || !Number.isFinite(receipt.requestedAt)) return null;
  if (now - receipt.requestedAt > RECEIPT_MAX_AGE_MS || receipt.requestedAt - now > RECEIPT_MAX_AGE_MS) return null;
  if (currentVersion === receipt.target) return { outcome: "updated", version: receipt.target };
  if (currentVersion === receipt.from) return { outcome: "unfinished", version: receipt.target };
  return null;
}

export function takeUpdateReceipt(userData, { currentVersion, now = Date.now() }) {
  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptFile(userData), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
  }
  clearUpdateReceipt(userData);
  return updateReceiptOutcome(receipt, { currentVersion, now });
}
