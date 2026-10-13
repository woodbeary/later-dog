import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  FIRST_SELF_UPDATING_VERSION,
  changelogSection,
  macUpdateYaml,
  packageFeedArguments,
  releaseFiles,
  releaseTag,
} from "./laterdog-release-files.mjs";

const SCRIPT = fileURLToPath(new URL("./laterdog-release-files.mjs", import.meta.url));
const FEED = "https://github.com/woodbeary/later-dog/releases/latest/download/";
const CHANGELOG = [
  "# Changelog",
  "",
  "## 0.3.4 — 2026-10-11",
  "",
  "### Fixes",
  "- **Pictures** show up \"right away\": no waiting.",
  "",
  "## 0.3.3 — unreleased",
  "",
  "- Older",
  "",
].join("\n");
const ZIP = Buffer.from("not really a zip, but bytes all the same");
const DMG = Buffer.from("not really a disk image either");

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("packageFeedArguments", () => {
  it("bakes an HTTPS feed into a signed build", () => {
    expect(packageFeedArguments({ identity: "later.dog Developer", feed: ` ${FEED} ` })).toEqual([`-c.extraMetadata.laterdogUpdateFeed=${FEED}`]);
    expect(packageFeedArguments({ identity: "later.dog Developer", feed: "" })).toEqual([]);
    expect(packageFeedArguments({ identity: "", feed: undefined })).toEqual([]);
  });

  it("refuses a feed an ad hoc build could never install from, or an unsafe one", () => {
    expect(() => packageFeedArguments({ identity: "", feed: FEED })).toThrow(/LATERDOG_MAC_IDENTITY/);
    expect(() => packageFeedArguments({ identity: "later.dog Developer", feed: "http://updates.example.test/" })).toThrow(/HTTPS/);
    expect(() => packageFeedArguments({ identity: "later.dog Developer", feed: "https://user:secret@updates.example.test/" })).toThrow(/without credentials/);
    expect(() => packageFeedArguments({ identity: "later.dog Developer", feed: "nope" })).toThrow(/not a URL/);
  });
});

describe("releaseTag", () => {
  it("accepts a tag that matches the app's version", () => {
    expect(releaseTag("v0.3.4", "0.3.4")).toEqual({ version: "0.3.4", prerelease: false });
    expect(releaseTag("v0.3.4-preview.2", "0.3.4")).toEqual({ version: "0.3.4", prerelease: true });
  });

  it("refuses a tag the app would keep offering itself as an update for", () => {
    expect(() => releaseTag("v0.3.5", "0.3.4")).toThrow(/does not match/);
    expect(() => releaseTag("0.3.4", "0.3.4")).toThrow(/vX\.Y\.Z/);
    expect(() => releaseTag("v0.3.4-beta", "0.3.4")).toThrow(/vX\.Y\.Z/);
    expect(() => releaseTag(undefined, "0.3.4")).toThrow(/vX\.Y\.Z/);
  });
});

describe("changelogSection", () => {
  it("returns one version's section up to the next one", () => {
    expect(changelogSection(CHANGELOG, "0.3.4")).toEqual({
      heading: "0.3.4 — 2026-10-11",
      body: "### Fixes\n- **Pictures** show up \"right away\": no waiting.",
    });
    expect(changelogSection(CHANGELOG, "0.3.3")).toEqual({ heading: "0.3.3 — unreleased", body: "- Older" });
    expect(changelogSection(CHANGELOG.replace(/\n/g, "\r\n"), "0.3.3")?.body).toBe("- Older");
    expect(changelogSection(CHANGELOG, "0.3")).toBeNull();
    expect(changelogSection(CHANGELOG, "0.3.40")).toBeNull();
  });
});

describe("releaseFiles", () => {
  const base = { tag: "v0.3.4", packageVersion: "0.3.4", changelog: CHANGELOG, zipName: "later.dog-macOS-arm64.zip", zipBytes: ZIP, repository: "woodbeary/later-dog", releaseDate: "2026-10-11T08:00:00.000Z" };

  it("writes the feed file electron-updater reads, pointing at this release's zip", () => {
    const files = releaseFiles(base);
    const info = parse(files["latest-mac.yml"]);
    const sha512 = createHash("sha512").update(ZIP).digest("base64");
    const url = "https://github.com/woodbeary/later-dog/releases/download/v0.3.4/later.dog-macOS-arm64.zip";
    expect(info).toEqual({
      version: "0.3.4",
      files: [{ url, sha512, size: ZIP.length }],
      path: url,
      sha512,
      releaseDate: "2026-10-11T08:00:00.000Z",
      releaseNotes: "### Fixes\n- **Pictures** show up \"right away\": no waiting.",
    });
    expect(info.files[0].url).toContain("arm64");
    expect(info.files[0].url.endsWith(".zip")).toBe(true);
    expect(files["SHA256SUMS.txt"]).toBe(`${createHash("sha256").update(ZIP).digest("hex")}  later.dog-macOS-arm64.zip\n`);
    expect(files["NOTES.md"]).toContain("## later.dog 0.3.4 for macOS (Apple silicon)");
    expect(files["NOTES.md"]).toContain(`**Already on later.dog ${FIRST_SELF_UPDATING_VERSION} or newer?** It updates itself.`);
    expect(files["NOTES.md"]).toContain("### What's new\n\n### Fixes\n- **Pictures**");
  });

  it("lists the disk image beside the zip and tells new installs to open it, while updates keep reading the zip", () => {
    const files = releaseFiles({ ...base, diskImageName: "later.dog-macOS-arm64.dmg", diskImageBytes: DMG });
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    expect(files["SHA256SUMS.txt"]).toBe(`${sha256(DMG)}  later.dog-macOS-arm64.dmg\n${sha256(ZIP)}  later.dog-macOS-arm64.zip\n`);
    expect(parse(files["latest-mac.yml"]).path).toBe("https://github.com/woodbeary/later-dog/releases/download/v0.3.4/later.dog-macOS-arm64.zip");
    expect(files["NOTES.md"]).toContain("**New install:** open **later.dog-macOS-arm64.dmg**, drag **later.dog** into Applications");
    expect(files["NOTES.md"]).toContain("The disk image's and the zip's SHA-256 are in `SHA256SUMS.txt`.");
    expect(files["NOTES.md"]).not.toContain("unzip");
    expect(releaseFiles({ ...base, notarized: true, diskImageName: "later.dog-macOS-arm64.dmg", diskImageBytes: DMG })["NOTES.md"]).toContain("**New install:** open **later.dog-macOS-arm64.dmg**, drag **later.dog** into Applications, then open it. It is signed");
    expect(releaseFiles(base)["NOTES.md"]).toContain("**New install:** unzip, drag **later.dog** into Applications");
  });

  it("gives a preview release no feed file, so nobody is offered it", () => {
    const files = releaseFiles({ ...base, tag: "v0.3.3-preview.1", packageVersion: "0.3.3" });
    expect(files["latest-mac.yml"]).toBeUndefined();
    expect(Object.keys(files).sort()).toEqual(["NOTES.md", "SHA256SUMS.txt"]);
  });

  it("refuses to publish a version the changelog still calls unreleased, or doesn't mention", () => {
    expect(() => releaseFiles({ ...base, tag: "v0.3.3", packageVersion: "0.3.3" })).toThrow(/unreleased/);
    expect(() => releaseFiles({ ...base, tag: "v0.3.5", packageVersion: "0.3.5" })).toThrow(/no "## 0\.3\.5" section/);
  });

  it("keeps quotes, colons and line breaks intact in the feed file", () => {
    const notes = "Line one: \"quoted\" # not a comment\n- item ✓";
    expect(parse(macUpdateYaml({ version: "1.0.0", url: "https://example.test/a.zip", sha512: "abc", size: 3, releaseDate: "2026-01-01T00:00:00.000Z", notes })).releaseNotes).toBe(notes);
    expect(parse(macUpdateYaml({ version: "1.0.0", url: "https://example.test/a.zip", sha512: "abc", size: 3, releaseDate: "2026-01-01T00:00:00.000Z" }))).not.toHaveProperty("releaseNotes");
  });
});

describe("the release files command", () => {
  it("writes the three files from a zip, the changelog and package.json", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "laterdog-release-files-"));
    directories.push(directory);
    const zip = path.join(directory, "later.dog-macOS-arm64.zip");
    fs.writeFileSync(zip, ZIP);
    fs.writeFileSync(path.join(directory, "CHANGELOG.md"), CHANGELOG);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "0.3.4" }));
    const out = path.join(directory, "out");
    const result = spawnSync(process.execPath, [SCRIPT, "--tag", "v0.3.4", "--zip", zip, "--out", out, "--repository", "woodbeary/later-dog", "--changelog", path.join(directory, "CHANGELOG.md"), "--package", path.join(directory, "package.json")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual(["NOTES.md", "SHA256SUMS.txt", "latest-mac.yml"]);
    expect(parse(fs.readFileSync(path.join(out, "latest-mac.yml"), "utf8")).version).toBe("0.3.4");
    const notes = fs.readFileSync(path.join(out, "NOTES.md"), "utf8");
    expect(notes).toContain("open it once");
    expect(notes).toContain("System Settings → Privacy & Security");
    expect(notes).toContain("**Open Anyway**");
    expect(notes).not.toContain("right-click");

    const notarizedOut = path.join(directory, "notarized");
    const notarized = spawnSync(process.execPath, [SCRIPT, "--tag", "v0.3.4", "--zip", zip, "--out", notarizedOut, "--repository", "woodbeary/later-dog", "--changelog", path.join(directory, "CHANGELOG.md"), "--package", path.join(directory, "package.json")], { encoding: "utf8", env: { ...process.env, LATERDOG_NOTARIZE: "1" } });
    expect(notarized.status, notarized.stderr).toBe(0);
    const signed = fs.readFileSync(path.join(notarizedOut, "NOTES.md"), "utf8");
    expect(signed).toContain("notarized by Apple");
    expect(signed).toContain("**On an older later.dog?** Download this once");
    expect(signed).toContain("**Already on later.dog 0.3.11 or newer?** It updates itself.");
    expect(signed).not.toContain("Open Anyway");

    const dmg = path.join(directory, "later.dog-macOS-arm64.dmg");
    fs.writeFileSync(dmg, DMG);
    const imageOut = path.join(directory, "image");
    const withImage = spawnSync(process.execPath, [SCRIPT, "--tag", "v0.3.4", "--zip", zip, "--dmg", dmg, "--out", imageOut, "--repository", "woodbeary/later-dog", "--changelog", path.join(directory, "CHANGELOG.md"), "--package", path.join(directory, "package.json")], { encoding: "utf8", env: { ...process.env, LATERDOG_NOTARIZE: "1" } });
    expect(withImage.status, withImage.stderr).toBe(0);
    expect(fs.readFileSync(path.join(imageOut, "SHA256SUMS.txt"), "utf8").split("\n").filter(Boolean).map((line) => line.split("  ")[1])).toEqual(["later.dog-macOS-arm64.dmg", "later.dog-macOS-arm64.zip"]);
    expect(fs.readFileSync(path.join(imageOut, "NOTES.md"), "utf8")).toContain("open **later.dog-macOS-arm64.dmg**");
    const missing = spawnSync(process.execPath, [SCRIPT, "--tag", "v0.3.4", "--zip", zip, "--dmg", path.join(directory, "nope.dmg"), "--out", imageOut, "--repository", "woodbeary/later-dog", "--changelog", path.join(directory, "CHANGELOG.md"), "--package", path.join(directory, "package.json")], { encoding: "utf8" });
    expect(missing.status).not.toBe(0);

    const refused = spawnSync(process.execPath, [SCRIPT, "--tag", "v0.3.4", "--zip", zip, "--out", out, "--repository", "not a repo", "--changelog", path.join(directory, "CHANGELOG.md"), "--package", path.join(directory, "package.json")], { encoding: "utf8" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Not a GitHub repository");
  });
});
