import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import type { WireMessage } from "../../shared/wire.ts";
import { rowForApps } from "./compaction-row.ts";
import { MODEL_SUMMARY_LABEL, personLine } from "./history-summary.ts";

const row = (summary: string, by: "harness" | "person" = "harness"): WireMessage => ({
  id: "c1", at: 1, role: "bot", kind: "compaction",
  compaction: { summary, firstKeptId: "m9", foldedThroughId: "m8", tokensBefore: 1_000, by },
});
const OLD = `${MODEL_SUMMARY_LABEL}\n**Model mismatch: this turn is running on claude-invented-1.** I cannot proceed.\n\nHistorical excerpts in chronological order\n- user: hello`;

it("sends an old stored summary of more than one line to the apps as one plain line, and leaves the stored row alone", () => {
  const stored = row(OLD);
  const sent = rowForApps(stored);
  expect(sent.compaction?.summary).toBe("Earlier messages in this chat were summarized.");
  expect(sent.compaction?.summary).not.toMatch(/\n/);
  expect(rowForApps(row(OLD, "person")).compaction?.summary).toBe(personLine("person"));
  expect(stored.compaction?.summary).toBe(OLD);
  expect(sent).toMatchObject({ id: "c1", kind: "compaction", compaction: { firstKeptId: "m9", foldedThroughId: "m8", tokensBefore: 1_000 } });
});

it("sends a new row's plain line and every other row as they are", () => {
  const fresh = row(personLine("account"));
  expect(rowForApps(fresh)).toBe(fresh);
  const text: WireMessage = { id: "t", at: 1, role: "bot", kind: "text", text: "two\nlines" };
  expect(rowForApps(text)).toBe(text);
});

it("passes every chat row the server sends to the apps through it", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(source).toMatch(/function slimMessage\(stored: Message\)[^{]*\{\n[^\n]*rowForApps\(/);
  expect(source).toMatch(/if \(limit === undefined\) \{\n\s*return \{ messages: store\.messagesFor\(threadId\)\.map\(rowForApps\)/);
});
