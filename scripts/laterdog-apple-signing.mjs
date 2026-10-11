import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const DEFAULT_REPO = "woodbeary/later-dog";
export const SECRET_NAMES = ["MAC_DEVELOPER_ID_P12", "MAC_DEVELOPER_ID_PASSWORD", "APPLE_API_KEY_P8", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
const ISSUER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Z0-9]{10}$/;

export const EXPORT_IDENTITY_C = `#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  const char *secret = getenv("LATERDOG_P12_OUT");
  if (argc < 3 || !secret) return 2;
  CFStringRef name = CFStringCreateWithCString(NULL, argv[1], kCFStringEncodingUTF8);
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(query, kSecClass, kSecClassIdentity);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitAll);
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  if (argc >= 4) {
    SecKeychainRef keychain = NULL;
    if (SecKeychainOpen(argv[3], &keychain) != errSecSuccess || !keychain) return 3;
    CFArrayRef list = CFArrayCreate(NULL, (const void **)&keychain, 1, &kCFTypeArrayCallBacks);
    CFDictionarySetValue(query, kSecMatchSearchList, list);
  }
  CFTypeRef found = NULL;
  if (SecItemCopyMatching(query, &found) != errSecSuccess || !found || CFGetTypeID(found) != CFArrayGetTypeID()) return 4;
  SecIdentityRef match = NULL;
  int matches = 0;
  for (CFIndex index = 0; index < CFArrayGetCount((CFArrayRef)found); index++) {
    SecIdentityRef identity = (SecIdentityRef)CFArrayGetValueAtIndex((CFArrayRef)found, index);
    SecCertificateRef certificate = NULL;
    if (SecIdentityCopyCertificate(identity, &certificate) != errSecSuccess || !certificate) continue;
    CFStringRef summary = SecCertificateCopySubjectSummary(certificate);
    if (summary && CFStringCompare(summary, name, 0) == kCFCompareEqualTo) { match = identity; matches++; }
  }
  if (matches != 1) return matches ? 6 : 5;
  SecItemImportExportKeyParameters parameters;
  memset(&parameters, 0, sizeof parameters);
  parameters.version = SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION;
  parameters.passphrase = CFStringCreateWithCString(NULL, secret, kCFStringEncodingUTF8);
  CFDataRef exported = NULL;
  OSStatus status = SecItemExport(match, kSecFormatPKCS12, 0, &parameters, &exported);
  if (status != errSecSuccess || !exported) { fprintf(stderr, "SecItemExport %d\\n", (int)status); return 7; }
  FILE *file = fopen(argv[2], "wb");
  if (!file) return 8;
  size_t length = (size_t)CFDataGetLength(exported);
  int ok = fwrite(CFDataGetBytePtr(exported), 1, length, file) == length;
  return fclose(file) == 0 && ok ? 0 : 8;
}
`;

const EXPORT_FAILURES = { 3: "the keychain could not be opened", 4: "no signing identities were found", 5: "no certificate has that exact name", 6: "more than one certificate has that name", 7: "macOS refused the export (was Allow clicked?)", 8: "the export could not be saved" };

export function parseArguments(argv) {
  const options = { repo: DEFAULT_REPO, identity: undefined, keyId: undefined, positional: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--repo" || arg === "--identity" || arg === "--key-id") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} needs a value.`);
      if (arg === "--repo") options.repo = value;
      else if (arg === "--identity") options.identity = value;
      else options.keyId = value;
    } else options.positional.push(arg);
  }
  const [keyPath, issuer] = options.positional;
  if (!keyPath || !issuer) throw new Error("Usage: pnpm laterdog:apple-signing <AuthKey_KEYID.p8> <issuer-id> [--key-id KEYID] [--identity NAME] [--repo owner/name]");
  const keyId = options.keyId ?? basename(keyPath).match(/^AuthKey_([A-Z0-9]{10})\.p8$/)?.[1];
  if (!keyId || !KEY_ID.test(keyId)) throw new Error("Keep the key file named AuthKey_<KEY ID>.p8 as Apple downloads it, or pass --key-id.");
  if (!ISSUER.test(issuer)) throw new Error("The issuer ID looks like 57246542-96fe-1a63-e053-0824d011072a. It is above the keys list in App Store Connect, Users and Access, Integrations.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error(`Not a GitHub repository: ${options.repo}`);
  return { keyPath: resolve(keyPath.replace(/^~(?=\/)/, homedir())), issuer: issuer.toLowerCase(), keyId, identity: options.identity, repo: options.repo };
}

export function developerIdNames(findIdentityOutput) {
  return [...new Set([...findIdentityOutput.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((match) => match[1]))];
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
}

export function exportIdentity({ identity, out, passphrase, keychain, work }) {
  const source = join(work, "export-identity.c");
  const binary = join(work, "export-identity");
  writeFileSync(source, EXPORT_IDENTITY_C, { mode: 0o600 });
  try {
    run("xcrun", ["clang", "-Wno-deprecated-declarations", "-framework", "Security", "-framework", "CoreFoundation", "-o", binary, source]);
  } catch (error) {
    throw new Error(`Could not build the keychain exporter (install the Xcode command line tools): ${String(error.stderr || error.message).trim().split("\n").slice(-1)[0]}`);
  }
  try {
    run(binary, [identity, out, ...(keychain ? [keychain] : [])], { env: { ...process.env, LATERDOG_P12_OUT: passphrase } });
  } catch (error) {
    const reason = EXPORT_FAILURES[error.status] ?? String(error.stderr || error.message).trim().split("\n").slice(-1)[0];
    throw new Error(`Could not export ${identity}: ${reason}.`);
  }
}

export function checkIdentityImports({ p12, passphrase, identity, work }) {
  const keychain = join(work, "check.keychain-db");
  run("security", ["create-keychain", "-p", randomBytes(24).toString("base64url"), keychain]);
  try {
    run("security", ["import", p12, "-k", keychain, "-P", passphrase, "-T", "/usr/bin/codesign"]);
    const found = developerIdNames(run("security", ["find-identity", "-v", "-p", "codesigning", keychain]));
    if (found.length !== 1 || found[0] !== identity) throw new Error("The exported certificate did not import as a valid signing identity.");
  } finally {
    try { run("security", ["delete-keychain", keychain]); } catch {}
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.platform !== "darwin") throw new Error("Run this on the Mac whose keychain holds the Developer ID certificate.");
  if (!existsSync(options.keyPath)) throw new Error(`No key file at ${options.keyPath}.`);
  const p8 = readFileSync(options.keyPath, "utf8");
  if (!p8.includes("-----BEGIN PRIVATE KEY-----")) throw new Error(`${options.keyPath} is not an App Store Connect API key.`);
  const names = developerIdNames(run("security", ["find-identity", "-v", "-p", "codesigning"]));
  const identity = options.identity ?? (names.length === 1 ? names[0] : undefined);
  if (!identity || !names.includes(identity)) {
    throw new Error(names.length ? `Pick one with --identity: ${names.map((name) => `"${name}"`).join(", ")}` : "No Developer ID Application certificate is in this Mac's keychain.");
  }
  run("gh", ["auth", "status"]);
  console.log(`Checking notarization key ${options.keyId} with Apple…`);
  try {
    run("xcrun", ["notarytool", "history", "--key", options.keyPath, "--key-id", options.keyId, "--issuer", options.issuer]);
  } catch (error) {
    throw new Error(`Apple refused the key: ${String(error.stderr || error.message).trim().split("\n").slice(-1)[0]}`);
  }
  const work = mkdtempSync(join(tmpdir(), "laterdog-signing-"));
  chmodSync(work, 0o700);
  try {
    const passphrase = randomBytes(24).toString("base64url");
    const p12 = join(work, "developer-id.p12");
    console.log(`Exporting ${identity}. macOS asks once: enter your Mac password and click Allow.`);
    exportIdentity({ identity, out: p12, passphrase, work });
    checkIdentityImports({ p12, passphrase, identity, work });
    const values = { MAC_DEVELOPER_ID_P12: readFileSync(p12).toString("base64"), MAC_DEVELOPER_ID_PASSWORD: passphrase, APPLE_API_KEY_P8: Buffer.from(p8).toString("base64"), APPLE_API_KEY_ID: options.keyId, APPLE_API_ISSUER: options.issuer };
    for (const name of SECRET_NAMES) run("gh", ["secret", "set", name, "--repo", options.repo], { input: values[name] });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Done. ${options.repo} now signs with ${identity} and notarizes with key ${options.keyId}.`);
  console.log(`Secrets set: ${SECRET_NAMES.join(", ")}. None were printed, and nothing is left on disk.`);
  console.log(`Next release: gh workflow run macos.yml --repo ${options.repo} --ref main -f release_tag=vX.Y.Z`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
