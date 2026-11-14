import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hideStaleBridgingModuleMap, hitStaleBridgingModuleMap } from "./build-speech-helper.mjs";

test("a stale bridging module map is told from the compiler's words, and nothing else is", () => {
  assert.equal(hitStaleBridgingModuleMap("module.modulemap:13:8: error: redefinition of module 'SwiftBridging'"), true);
  assert.equal(hitStaleBridgingModuleMap("speech-helper.swift:1:8: error: no such module 'Speech'"), false);
});

test("the stale module map is hidden behind an empty file for both the compiler and its C importer", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "laterdog-speech-test-"));
  try {
    const flags = hideStaleBridgingModuleMap(folder);
    const overlay = flags.at(-1);
    assert.deepEqual(flags, ["-Xcc", "-ivfsoverlay", "-Xcc", overlay, "-vfsoverlay", overlay]);
    const { roots } = JSON.parse(readFileSync(overlay, "utf8"));
    assert.equal(roots.length, 1);
    assert.equal(roots[0].name, "/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap");
    assert.equal(readFileSync(roots[0]["external-contents"], "utf8"), "");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
