import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("later.dog builds, tests and releases run from Jacob's Mac", () => {
  it("keeps no GitHub Actions workflows", () => {
    expect(existsSync(new URL(".github/workflows/", root))).toBe(false);
  });

  it("ships the desktop release from an executable Mac script that notarizes before publishing", () => {
    const script = new URL("scripts/laterdog-release-mac.sh", root);
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const text = readFileSync(script, "utf8");
    const notarized = text.indexOf("xcrun stapler staple \"$DMG\"");
    const published = text.indexOf("gh release create");
    expect(notarized).toBeGreaterThan(0);
    expect(published).toBeGreaterThan(notarized);
    expect(text).toContain("refusing to replace its binaries");
    expect(text).toContain("scripts/laterdog-release-files.mjs");
  });

  it("refuses to release an app without its dictation helper, before anything is notarized", () => {
    const text = readFileSync(new URL("scripts/laterdog-release-mac.sh", root), "utf8");
    const refused = text.indexOf("Refusing to release without dictation");
    expect(refused).toBeGreaterThan(text.indexOf("later.dog Speech.app/Contents/MacOS/speech-helper"));
    expect(text.indexOf("== Notarize and staple the app")).toBeGreaterThan(refused);
  });

  it("points the release doc at the Mac script, not a workflow", () => {
    const doc = readFileSync(new URL("docs/laterdog/releasing.md", root), "utf8");
    expect(doc).toContain("scripts/laterdog-release-mac.sh");
    expect(doc).not.toContain("gh workflow run");
  });
});
