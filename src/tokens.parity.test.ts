import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

it.each([
  ["--radius-bubble", "20px"],
  ["--radius-card", "12px"],
  ["--radius-question", "24px"],
  ["--radius-menu", "12px"],
  ["--radius-composer", "22px"],
  ["--radius-row", "8px"],
])("rounds %s to %s", (token, value) => {
  expect(tokens).toMatch(new RegExp(`${token}:\\s*${value};`));
});
