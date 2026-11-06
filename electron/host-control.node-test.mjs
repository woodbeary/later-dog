import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HOST_CONTROL_TIMEOUT_MS, HOST_HELD, hostControlRefusal } from "./host-control.mjs";

test("only a real conflict says the Mac is held; other refusals say what failed", () => {
  assert.equal(hostControlRefusal(409), HOST_HELD);
  assert.match(hostControlRefusal(401), /couldn't start computer control \(status 401\)/);
  assert.ok(HOST_CONTROL_TIMEOUT_MS >= 10_000);
});

test("a control check that fails or times out releases its own claim, so the next request isn't told the Mac is held", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /try \{\n\s+await lease\("acquire"\);\n\s+\} catch \(error\) \{\n\s+await lease\("release"\)\.catch\(\(\) => \{\}\);\n\s+throw error;/);
});
