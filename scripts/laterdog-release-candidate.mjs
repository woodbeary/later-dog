import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fileDigest, releaseFiles } from "./laterdog-release-files.mjs";

export const CANDIDATE_ARTIFACT = "later.dog-release-candidate";
export const RELEASE_ASSETS = ["later.dog-macOS-arm64.zip", "later.dog-macOS-arm64.dmg", "SHA256SUMS.txt", "latest-mac.yml"];
export const ACCEPTANCE_CHECKS = ["fresh-install", "previous-stable-upgrade", "expo-development", "exact-testflight-build", "real-account-conversation", "real-iphone", "workspace-identity", "desktop-mobile-compatibility", "native-claude", "native-codex", "independent-review"];
export const PHONE_IDENTITY_FIELDS = ["sourceSha", "appVersion", "runtimeVersion", "buildNumber", "ascBuildId", "easBuildId"];
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function candidateManifest({ directory, tag, version, sha, repository, runId, identity, appNotary, dmgNotary }) {
  if (tag !== `v${version}` || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A candidate requires a stable tag matching the app version.");
  if (!shaPattern.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[1-9]\d*$/.test(String(runId))) throw new Error("Invalid candidate source or workflow run.");
  if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity)) throw new Error("A candidate requires a Developer ID Application identity.");
  for (const receipt of [appNotary, dmgNotary]) if (receipt?.status !== "Accepted" || typeof receipt.id !== "string" || !receipt.id) throw new Error("Both the app and disk image must have accepted notarization receipts.");
  const files = Object.fromEntries([...RELEASE_ASSETS, "NOTES.md"].map(name => [name, fileDigest(readFileSync(join(directory, name)))]));
  return { schemaVersion: 1, tag, version, sha, repository, runId: String(runId), identity, notarization: { app: appNotary.id, dmg: dmgNotary.id }, files };
}

export function verifyCandidate(directory, candidate) {
  if (candidate?.schemaVersion !== 1 || !shaPattern.test(candidate.sha) || candidate.tag !== `v${candidate.version}` || !/^\d+\.\d+\.\d+$/.test(candidate.version)) throw new Error("Invalid candidate manifest.");
  if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(candidate.identity) || !candidate.notarization?.app || !candidate.notarization?.dmg) throw new Error("Candidate signing evidence is missing.");
  for (const name of [...RELEASE_ASSETS, "NOTES.md"]) {
    const expected = candidate.files?.[name];
    const actual = fileDigest(readFileSync(join(directory, name)));
    if (!expected || !digestPattern.test(expected.sha256) || actual.sha256 !== expected.sha256 || actual.sha512 !== expected.sha512 || actual.size !== expected.size) throw new Error(`Candidate bytes changed: ${name}`);
  }
  return candidate;
}

export function verifyAcceptance(candidate, evidence) {
  if (evidence?.schemaVersion !== 2 || evidence.sourceSha !== candidate.sha || evidence.version !== candidate.version || String(evidence.candidateRunId) !== candidate.runId) throw new Error("Acceptance evidence does not match the candidate source, version and run.");
  for (const name of RELEASE_ASSETS.slice(0, 2)) if (evidence.assets?.[name] !== candidate.files[name].sha256) throw new Error(`Acceptance evidence did not verify these bytes: ${name}`);
  const phone = evidence.phone;
  if (!phone || !shaPattern.test(phone.sourceSha) || !versionPattern.test(phone.appVersion) || typeof phone.runtimeVersion !== "string" || !phone.runtimeVersion.trim() || !/^[1-9]\d*$/.test(phone.buildNumber) || !uuidPattern.test(phone.ascBuildId) || !uuidPattern.test(phone.easBuildId)) throw new Error("Acceptance requires a frozen phone source, app/runtime version, build number, ASC build ID and EAS build ID.");
  for (const provider of ["claude", "codex"]) if (!versionPattern.test(evidence.providerVersions?.[provider] ?? "")) throw new Error(`Acceptance requires an exact ${provider} version.`);
  for (const name of ACCEPTANCE_CHECKS) {
    const check = evidence.checks?.[name];
    if (check?.status !== "pass" || typeof check.evidence !== "string" || !check.evidence.trim()) throw new Error(`Required acceptance is missing: ${name}`);
    if (check.sourceSha !== (name === "expo-development" ? phone.sourceSha : candidate.sha)) throw new Error(`Acceptance is not pinned to the source commit: ${name}`);
  }
  const development = evidence.checks["expo-development"];
  if (development.appVersion !== phone.appVersion || development.runtimeVersion !== phone.runtimeVersion) throw new Error("Expo development acceptance does not match the frozen phone app and runtime.");
  for (const name of ["exact-testflight-build", "real-iphone", "desktop-mobile-compatibility"]) {
    if (PHONE_IDENTITY_FIELDS.some(field => evidence.checks[name].phone?.[field] !== phone[field])) throw new Error(`Acceptance does not match the exact frozen phone build: ${name}`);
  }
  if (evidence.checks["real-iphone"].deviceType !== "physical") throw new Error("Real iPhone acceptance requires a physical device.");
  for (const name of ["real-account-conversation", "workspace-identity", "independent-review"]) if (evidence.checks[name].phoneSourceSha !== phone.sourceSha) throw new Error(`Acceptance is not pinned to the phone source commit: ${name}`);
  for (const provider of ["claude", "codex"]) if (evidence.checks[`native-${provider}`].providerVersion !== evidence.providerVersions[provider]) throw new Error(`Native acceptance does not match the frozen ${provider} version.`);
  return evidence;
}

function main() {
  const { values } = parseArgs({ options: Object.fromEntries(["directory", "tag", "sha", "repository", "run-id", "identity", "app-notary", "dmg-notary"].map(name => [name, { type: "string" }])) });
  const directory = resolve(values.directory ?? "out");
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const generated = releaseFiles({ tag: values.tag, packageVersion: version, changelog: readFileSync("CHANGELOG.md", "utf8"), zipName: RELEASE_ASSETS[0], zipBytes: readFileSync(join(directory, RELEASE_ASSETS[0])), diskImageName: RELEASE_ASSETS[1], diskImageBytes: readFileSync(join(directory, RELEASE_ASSETS[1])), repository: values.repository, releaseDate: new Date().toISOString(), notarized: true });
  for (const [name, content] of Object.entries(generated)) writeFileSync(join(directory, name), content);
  const candidate = candidateManifest({ directory, tag: values.tag, version, sha: values.sha, repository: values.repository, runId: values["run-id"], identity: values.identity, appNotary: JSON.parse(readFileSync(values["app-notary"], "utf8")), dmgNotary: JSON.parse(readFileSync(values["dmg-notary"], "utf8")) });
  writeFileSync(join(directory, "candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`Prepared ${candidate.tag} at ${candidate.sha}; stable distribution is unchanged.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
