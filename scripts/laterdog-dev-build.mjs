import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEV, VARIANT_FIELD, describeVariant } from "../electron/app-variant.mjs";
import { fileDigest, macUpdateYaml } from "./laterdog-release-files.mjs";

export const DEV_RELEASE_TAG = "dev-latest";
export const DEV_BUILDER_CONFIG = "electron-builder.dev.yml";
export const DEV_ZIP_NAME = "later.dog-Dev-macOS-arm64.zip";
export const DEV_DMG_NAME = "later.dog-Dev-macOS-arm64.dmg";

export function devVersion(packageVersion, runNumber) {
  if (!/^\d+\.\d+\.\d+$/.test(String(packageVersion))) throw new Error(`package.json's version ${packageVersion} is not X.Y.Z.`);
  if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error(`The run number ${runNumber} is not a positive integer.`);
  return `${packageVersion}-dev.${runNumber}`;
}

export function devFeedUrl(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repository))) throw new Error(`Not a GitHub repository: ${repository}`);
  return `https://github.com/${repository}/releases/download/${DEV_RELEASE_TAG}/`;
}

export function devAppPath(arch = "arm64") {
  return `release/mac-${arch}/${describeVariant(DEV).productName}.app`;
}

export function builderArguments(variantId, { version } = {}) {
  if (variantId !== DEV) return [];
  return ["--config", DEV_BUILDER_CONFIG, `-c.extraMetadata.${VARIANT_FIELD}=${DEV}`, ...(version ? [`-c.extraMetadata.version=${version}`] : [])];
}

export function devNotes({ sha, subject }) {
  const short = String(sha ?? "").slice(0, 9);
  return `Dev build of ${short || "an unknown commit"}${subject ? `: ${subject}` : ""}`.slice(0, 500);
}

export function devReleaseFiles({ version, repository, zipName = DEV_ZIP_NAME, zipBytes, diskImageName, diskImageBytes, releaseDate, notes }) {
  const digest = fileDigest(zipBytes);
  const sums = [...(diskImageBytes ? [`${fileDigest(diskImageBytes).sha256}  ${diskImageName}`] : []), `${digest.sha256}  ${zipName}`];
  return {
    "dev-mac.yml": macUpdateYaml({
      version,
      url: `${devFeedUrl(repository)}${encodeURIComponent(zipName)}`,
      sha512: digest.sha512,
      size: digest.size,
      releaseDate,
      notes,
    }),
    "SHA256SUMS.txt": `${sums.join("\n")}\n`,
    "NOTES.md": [
      `## later.dog Dev ${version}`,
      "",
      notes,
      "",
      "This is a rolling build of the `dev` branch. It installs beside later.dog, keeps its own data in `~/.laterdog-dev` and updates itself from this release.",
      "",
    ].join("\n"),
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      zip: { type: "string" },
      dmg: { type: "string" },
      out: { type: "string" },
      repository: { type: "string", default: process.env.GITHUB_REPOSITORY || "woodbeary/later-dog" },
      sha: { type: "string", default: process.env.GITHUB_SHA || "" },
      subject: { type: "string", default: "" },
    },
  });
  if (!values.version || !values.zip || !values.out) throw new Error("Usage: laterdog-dev-build.mjs --version X.Y.Z-dev.N --zip later.dog-Dev-macOS-arm64.zip [--dmg later.dog-Dev-macOS-arm64.dmg] --out out");
  const zipPath = resolve(values.zip);
  if (!statSync(zipPath).isFile()) throw new Error(`Not a file: ${zipPath}`);
  const dmgPath = values.dmg ? resolve(values.dmg) : null;
  const files = devReleaseFiles({
    version: values.version,
    repository: values.repository,
    zipName: basename(zipPath),
    zipBytes: readFileSync(zipPath),
    ...(dmgPath ? { diskImageName: basename(dmgPath), diskImageBytes: readFileSync(dmgPath) } : {}),
    releaseDate: new Date().toISOString(),
    notes: devNotes({ sha: values.sha, subject: values.subject }),
  });
  mkdirSync(values.out, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(values.out, name), text);
    console.log(`wrote ${join(values.out, name)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
