import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { UPDATE_FEED_FIELD } from "../electron/update-feed.mjs";

export const FIRST_SELF_UPDATING_VERSION = "0.3.3";

export function packageFeedArguments({ identity, feed }) {
  const text = typeof feed === "string" ? feed.trim() : "";
  if (!text) return [];
  if (!identity?.trim()) {
    throw new Error("LATERDOG_UPDATE_FEED needs LATERDOG_MAC_IDENTITY: macOS installs an update only when it carries the running app's signature, and an ad hoc signature changes with every build.");
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`LATERDOG_UPDATE_FEED is not a URL: ${text}`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("LATERDOG_UPDATE_FEED must be an HTTPS URL without credentials.");
  }
  return [`-c.extraMetadata.${UPDATE_FEED_FIELD}=${url.href}`];
}

export function releaseTag(tag, packageVersion) {
  const match = /^v(\d+\.\d+\.\d+)(-preview\.\d+)?$/.exec(String(tag ?? ""));
  if (!match) throw new Error(`Release tags are vX.Y.Z or vX.Y.Z-preview.N, not ${tag}.`);
  if (match[1] !== packageVersion) throw new Error(`Tag ${tag} does not match package.json's version ${packageVersion}.`);
  return { version: match[1], prerelease: Boolean(match[2]) };
}

export function changelogSection(markdown, version) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const escaped = version.replace(/\./g, "\\.");
  const start = lines.findIndex((line) => new RegExp(`^## ${escaped}(?:\\s|$)`).test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return { heading: lines[start].slice(3).trim(), body };
}

export function fileDigest(bytes) {
  return { sha512: createHash("sha512").update(bytes).digest("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

export function macUpdateYaml({ version, url, sha512, size, releaseDate, notes }) {
  const lines = [
    `version: ${JSON.stringify(version)}`,
    "files:",
    `  - url: ${JSON.stringify(url)}`,
    `    sha512: ${JSON.stringify(sha512)}`,
    `    size: ${size}`,
    `path: ${JSON.stringify(url)}`,
    `sha512: ${JSON.stringify(sha512)}`,
    `releaseDate: ${JSON.stringify(releaseDate)}`,
  ];
  if (notes) lines.push(`releaseNotes: ${JSON.stringify(notes)}`);
  return `${lines.join("\n")}\n`;
}

export function releaseNotesMarkdown({ version, notes }) {
  return [
    `## later.dog ${version} for macOS (Apple silicon)`,
    "",
    `**Already on later.dog ${FIRST_SELF_UPDATING_VERSION} or newer?** It updates itself. The update downloads in the background, and a small icon at the top of the sidebar appears when it is ready. Click it, then **Restart to update**.`,
    "",
    "**New install:** unzip, drag **later.dog** into Applications, then right-click it and choose **Open** the first time. The app is signed with later.dog's own certificate, not Apple's, so macOS asks once. Every release carries the same signature, so updates keep your keychain access and the Accessibility and Screen Recording permissions you granted.",
    "",
    "### What's new",
    "",
    notes || "Small fixes.",
    "",
    "The zip's SHA-256 is in `SHA256SUMS.txt`.",
    "",
  ].join("\n");
}

export function releaseFiles({ tag, packageVersion, changelog, zipName, zipBytes, repository, releaseDate }) {
  const { version, prerelease } = releaseTag(tag, packageVersion);
  const section = changelogSection(changelog, version);
  if (!section) throw new Error(`CHANGELOG.md has no "## ${version}" section.`);
  if (!prerelease && /unreleased/i.test(section.heading)) {
    throw new Error(`CHANGELOG.md still calls ${version} unreleased. Date its heading before publishing it.`);
  }
  const digest = fileDigest(zipBytes);
  const files = {
    "NOTES.md": releaseNotesMarkdown({ version, notes: section.body }),
    "SHA256SUMS.txt": `${digest.sha256}  ${zipName}\n`,
  };
  if (!prerelease) {
    files["latest-mac.yml"] = macUpdateYaml({
      version,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(zipName)}`,
      sha512: digest.sha512,
      size: digest.size,
      releaseDate,
      notes: section.body,
    });
  }
  return files;
}

function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      zip: { type: "string" },
      out: { type: "string" },
      repository: { type: "string", default: process.env.GITHUB_REPOSITORY || "woodbeary/later-dog" },
      changelog: { type: "string", default: "CHANGELOG.md" },
      package: { type: "string", default: "package.json" },
    },
  });
  if (!values.tag || !values.zip || !values.out) throw new Error("Usage: laterdog-release-files.mjs --tag vX.Y.Z --zip later.dog-macOS-arm64.zip --out out");
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repository)) throw new Error(`Not a GitHub repository: ${values.repository}`);
  const zipPath = resolve(values.zip);
  if (!statSync(zipPath).isFile()) throw new Error(`Not a file: ${zipPath}`);
  const files = releaseFiles({
    tag: values.tag,
    packageVersion: JSON.parse(readFileSync(values.package, "utf8")).version,
    changelog: readFileSync(values.changelog, "utf8"),
    zipName: basename(zipPath),
    zipBytes: readFileSync(zipPath),
    repository: values.repository,
    releaseDate: new Date().toISOString(),
  });
  mkdirSync(values.out, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(values.out, name), text);
    console.log(`wrote ${join(values.out, name)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
