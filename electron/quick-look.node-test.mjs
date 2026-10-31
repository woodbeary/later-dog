import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearQuickLookFiles, QUICK_LOOK_MAX_BYTES, quickLookBytes, quickLookName, writeQuickLookFile } from "./quick-look.mjs";

test("keeps a document's own name and refuses kinds Quick Look shouldn't open", () => {
  assert.equal(quickLookName("Q3 report.PDF"), "Q3 report.pdf");
  assert.equal(quickLookName("/home/dog/work/plan.xlsx"), "plan.xlsx");
  assert.equal(quickLookName("C:\\deck\\pitch.key"), "pitch.key");
  assert.equal(quickLookName("notes\u0000\u001b.docx"), "notes.docx");
  assert.equal(quickLookName("a:b.pages"), "a b.pages");
  assert.equal(quickLookName(`${"x".repeat(300)}.pptx`).length, 120);
  for (const refused of ["run.sh", "app.dmg", "page.html", "image.svg", ".pdf", "..pdf", "noextension", "", 7, null]) {
    assert.equal(quickLookName(refused), null, String(refused));
  }
});

test("takes bytes up to the limit and nothing else", () => {
  assert.ok(quickLookBytes(new Uint8Array([1])));
  assert.ok(quickLookBytes(Buffer.from("pdf")));
  assert.equal(quickLookBytes(new Uint8Array()), null);
  assert.equal(quickLookBytes(new Uint8Array(QUICK_LOOK_MAX_BYTES + 1)), null);
  assert.equal(quickLookBytes("text"), null);
  assert.equal(quickLookBytes(new ArrayBuffer(4)), null);
});

test("writes each preview to a fresh private folder and clears the one before", async () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "ql-test-")), "previews");
  const first = await writeQuickLookFile(root, "a.pdf", new Uint8Array([37, 80, 68, 70]));
  assert.equal(readFileSync(first, "utf8"), "%PDF");
  assert.equal(statSync(first).mode & 0o777, 0o600);
  assert.equal(path.basename(first), "a.pdf");
  const second = await writeQuickLookFile(root, "b.xlsx", new Uint8Array([1]));
  assert.equal(existsSync(first), false);
  assert.ok(existsSync(second));
  await clearQuickLookFiles(root);
  assert.equal(existsSync(root), false);
});
