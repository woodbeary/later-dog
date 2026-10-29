import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(electronDir);
const resourcesDir = path.join(electronDir, "resources");

export const speechHelperBundle = path.join(resourcesDir, "later.dog Speech.app");
export const speechHelperBinary = path.join(speechHelperBundle, "Contents", "MacOS", "speech-helper");

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || "").trim().split("\n").slice(0, 20).join("\n");
        reject(new Error(`${command} failed: ${error.message}${detail ? `\n${detail}` : ""}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export async function buildSpeechHelper() {
  const contents = path.join(speechHelperBundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  copyFileSync(path.join(resourcesDir, "speech-helper-Info.plist"), path.join(contents, "Info.plist"));
  const localPackage = process.env.LATERDOG_LOCAL_PACKAGE === "1";
  const archList = localPackage ? [process.arch === "arm64" ? "arm64" : "x86_64"] : ["arm64", "x86_64"];
  const slices = [];
  try {
    for (const arch of archList) {
      const slice = `${speechHelperBinary}-${arch}`;
      slices.push(slice);
      await run(
        "swiftc",
        [localPackage ? "-Onone" : "-O", "-target", `${arch}-apple-macos12`, path.join(resourcesDir, "speech-helper.swift"), "-o", slice],
        120_000,
      );
    }
    await run("lipo", ["-create", ...slices, "-output", speechHelperBinary], 60_000);
  } finally {
    for (const slice of slices) rmSync(slice, { force: true });
  }
  const archs = await run("lipo", ["-archs", speechHelperBinary], 60_000);
  if (archList.some(arch => !archs.trim().split(/\s+/).includes(arch))) {
    throw new Error(`speech helper lacks the requested architecture: ${archs.trim()}`);
  }
  await run(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      path.join(projectDir, "build", "entitlements.mac.plist"),
      speechHelperBundle,
    ],
    30_000,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await buildSpeechHelper();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
