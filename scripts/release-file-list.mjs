import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_PART = "/Contents/Resources/server/";
export const HASHED_UI_PART = "/Contents/Resources/ui/assets/";

export function appFiles(listing) {
  return new Set(listing.split("\n").map((line) => line.trimEnd()).filter((line) => line && !line.endsWith("/")));
}

export function mayChangeFreely(path) {
  return path.includes(SERVER_PART) || path.includes(HASHED_UI_PART);
}

export function goneFiles(previous, current, accepted = []) {
  const now = appFiles(current);
  const allowed = new Set(accepted);
  return [...appFiles(previous)].filter((path) => !now.has(path) && !mayChangeFreely(path) && !allowed.has(path)).sort();
}

export function acceptedFrom(value) {
  return (value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [previousFile, currentFile] = process.argv.slice(2);
  if (!previousFile || !currentFile) {
    console.error("Usage: node scripts/release-file-list.mjs <previous release file list> <new app file list>");
    process.exit(2);
  }
  const previous = readFileSync(previousFile, "utf8");
  const current = readFileSync(currentFile, "utf8");
  const gone = goneFiles(previous, current, acceptedFrom(process.env.LATERDOG_RELEASE_ACCEPT_GONE));
  console.log(`Files: ${appFiles(previous).size} in the previous release, ${appFiles(current).size} now`);
  if (gone.length) {
    console.error(`${gone.length} file(s) outside server/ that the previous release had are gone:`);
    for (const path of gone) console.error(`  ${path}`);
    console.error("If each one is meant to be gone, list them one per line in LATERDOG_RELEASE_ACCEPT_GONE and run again.");
    process.exit(1);
  }
  console.log("Nothing outside server/ is gone.");
}
