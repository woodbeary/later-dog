import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ACCEPTANCE_CHECKS } from "./laterdog-release-candidate.mjs";
import { providerPins } from "./cloud-image-receipt.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
export const PHONE_APP_ID = "6822519577";
export const PHONE_BUNDLE_ID = "dog.later.phone";
export const PHONE_PROJECT_ID = "0fab07eb-098b-497f-a001-bb5af3014552";

export function retainedEvidence(directory, reference) {
  if (!reference || typeof reference.path !== "string" || !reference.path || isAbsolute(reference.path) || !digestPattern.test(reference.sha256 ?? "")) throw new Error("A retained relative evidence path and SHA-256 are required.");
  const root = realpathSync(directory);
  const path = resolve(root, reference.path);
  const outside = value => value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
  if (outside(relative(root, path)) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || outside(relative(root, realpathSync(path)))) throw new Error("Release evidence must be a regular file inside the private evidence directory.");
  if (lstatSync(path).size > 128 * 1024 * 1024) throw new Error("A release evidence file exceeds the verification limit.");
  const bytes = readFileSync(path);
  if (hash(bytes) !== reference.sha256) throw new Error("Retained release evidence changed after acceptance.");
  return bytes;
}

export function verifyPrivateReceipts(candidate, evidence, directory) {
  for (const name of ACCEPTANCE_CHECKS.filter(name => name !== "independent-review")) {
    const check = evidence.checks[name];
    const receipt = JSON.parse(retainedEvidence(directory, check.receipt).toString("utf8"));
    if (receipt.schemaVersion !== 1 || receipt.check !== name || receipt.status !== "pass" || receipt.sourceSha !== check.sourceSha || receipt.candidateRunId !== candidate.runId || receipt.desktopZipSha256 !== candidate.files["later.dog-macOS-arm64.zip"].sha256 || receipt.phoneSourceSha !== evidence.phone.sourceSha || receipt.ascBuildId !== evidence.phone.ascBuildId || receipt.cloudImageDigest !== evidence.cloud.imageDigest || !Array.isArray(receipt.observations) || !receipt.observations.length || receipt.observations.some(value => typeof value !== "string" || !value.trim()) || !Array.isArray(receipt.artifacts) || !receipt.artifacts.length) throw new Error(`Private acceptance receipt is incomplete or belongs to another build: ${name}`);
    for (const artifact of receipt.artifacts) retainedEvidence(directory, artifact);
  }
}

function reviewManifest(patch) {
  const files = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  if (files.length !== 1 || files[0][1] !== ".laterdog-review.json" || files[0][2] !== ".laterdog-review.json") throw new Error("Independent review artifact changed files outside its review scope.");
  return JSON.parse(patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1)).join("\n"));
}

export async function verifyReleaseAuthority({ candidate, evidence, api, directory }) {
  verifyPrivateReceipts(candidate, evidence, directory);
  const sources = { desktop: candidate.sha, phone: evidence.phone.sourceSha, cloud: evidence.cloud.sourceSha };
  for (const [name, sha] of Object.entries(sources)) {
    const source = evidence.sources?.[name];
    const review = evidence.reviews?.[name];
    if (!source || !repositoryPattern.test(source.repository ?? "") || !Number.isSafeInteger(source.prNumber) || source.prNumber < 1 || (name !== "phone" && source.repository !== candidate.repository)) throw new Error(`A reviewed merged source PR is required: ${name}`);
    if (!review) throw new Error(`A pinned independent review artifact is required: ${name}`);
    const actual = await api.source(source, sha);
    if (actual.pull?.merged !== true || actual.pull.base?.ref !== "main" || actual.pull.base.repo?.full_name !== source.repository || actual.pull.head?.sha !== sha || actual.comparison?.merge_base_commit?.sha !== sha) throw new Error(`Release source is not the reviewed PR head merged into main: ${name}`);
    if (name === "phone" && review.kind === "retained-independent-session") {
      const report = JSON.parse(retainedEvidence(directory, review.artifact).toString("utf8"));
      if (report.headSha !== sha || report.repository !== source.repository || report.verdict !== "pass" || typeof report.summary !== "string" || !report.summary.trim() || !Array.isArray(report.checked) || !report.checked.length || report.checked.some(value => typeof value !== "string" || !value.trim()) || !Array.isArray(report.limitations) || report.reviewer?.kind !== "isolated-agent" || typeof report.reviewer.sessionId !== "string" || !report.reviewer.sessionId || typeof report.implementationSessionId !== "string" || !report.implementationSessionId || report.reviewer.sessionId === report.implementationSessionId) throw new Error("The retained independent phone review is incomplete, stale or did not pass.");
      continue;
    }
    if (!review.jobId || !digestPattern.test(review.patchSha256 ?? "") || (review.kind !== "supervisor-standalone" && !review.reviewerJobId)) throw new Error(`A pinned independent supervisor review artifact is required: ${name}`);
    const result = await api.review(review);
    if (review.kind === "supervisor-standalone") {
      const job = result.reviewer?.job;
      const patch = result.patch?.patch;
      if (job?.id !== review.jobId || job.repository !== source.repository || job.kind !== "implementation" || job.state !== "ready" || job.cancelRequested || !job.taskId || typeof review.implementationSessionId !== "string" || !review.implementationSessionId || job.taskId === review.implementationSessionId || job.baseSha !== sha || typeof job.sourceRef !== "string" || !job.sourceRef.startsWith("laterdog/input/") || typeof job.brief !== "string" || !job.brief.includes(sha) || JSON.stringify(job.writeScopes) !== '[".laterdog-review.json"]' || typeof patch !== "string" || hash(patch) !== review.patchSha256) throw new Error(`Standalone independent review is incomplete or stale: ${name}`);
      const pinned = await api.reviewSource(source.repository, job.baseSha, sha, job.sourceRef);
      if (pinned.input?.sha !== job.baseSha || pinned.comparison?.merge_base_commit?.sha !== job.baseSha) throw new Error(`Standalone review input could not be verified: ${name}`);
      const report = reviewManifest(patch);
      if (report.headSha !== sha || report.verdict !== "pass" || typeof report.summary !== "string" || !report.summary.trim()) throw new Error(`Standalone independent review did not pass this source: ${name}`);
      continue;
    }
    const parent = result.parent?.job;
    const reviewer = result.reviewer?.job;
    const patch = result.patch?.patch;
    if (parent?.id !== review.jobId || parent.repository !== source.repository || parent.prNumber !== source.prNumber || parent.headSha !== sha || parent.review?.headSha !== sha || parent.review.verdict !== "pass" || parent.review.reviewerJobId !== review.reviewerJobId || reviewer?.id !== review.reviewerJobId || reviewer.id === parent.id || reviewer.kind !== "review" || reviewer.parentId !== parent.id || reviewer.repository !== source.repository || reviewer.baseSha !== sha || reviewer.state !== "ready" || reviewer.cancelRequested || !reviewer.taskId || reviewer.taskId === parent.taskId || typeof patch !== "string" || hash(patch) !== review.patchSha256) throw new Error(`Independent review is missing, stale or did not pass: ${name}`);
    const report = reviewManifest(patch);
    if (report.headSha !== sha || report.verdict !== "pass" || typeof report.summary !== "string" || !report.summary.trim() || report.summary !== parent.review.summary) throw new Error(`Independent review verdict does not match its retained artifact: ${name}`);
  }
  const phone = await api.phone(evidence.phone);
  const build = phone.build?.data;
  const app = phone.app?.data;
  const version = phone.version?.data;
  const beta = phone.beta?.data;
  const eas = phone.eas;
  const testing = beta?.attributes?.internalBuildState === "IN_BETA_TESTING" || beta?.attributes?.externalBuildState === "IN_BETA_TESTING";
  if (build?.id !== evidence.phone.ascBuildId || build.attributes?.version !== evidence.phone.buildNumber || build.attributes.processingState !== "VALID" || build.attributes.expired !== false || app?.id !== PHONE_APP_ID || app.attributes?.bundleId !== PHONE_BUNDLE_ID || version?.attributes?.version !== evidence.phone.appVersion || version.attributes.platform !== "IOS" || !testing) throw new Error("The exact App Store Connect build is not valid and available for TestFlight acceptance testing.");
  if (eas?.id !== evidence.phone.easBuildId || eas.project?.id !== PHONE_PROJECT_ID || eas.status !== "FINISHED" || eas.platform !== "IOS" || eas.distribution !== "STORE" || eas.isForIosSimulator === true || eas.isGitWorkingTreeDirty !== false || eas.buildProfile !== "beta" || eas.channel !== "beta" || eas.gitCommitHash !== evidence.phone.sourceSha || eas.appVersion !== evidence.phone.appVersion || eas.appBuildVersion !== evidence.phone.buildNumber || eas.runtimeVersion !== evidence.phone.runtimeVersion) throw new Error("The exact EAS build does not match a clean accepted phone source and runtime.");
  const cloud = evidence.cloud;
  if (!/^[1-9]\d*$/.test(String(cloud.buildRunId)) || !digestPattern.test(cloud.receiptSha256 ?? "")) throw new Error("A trusted Cloud image workflow run and receipt hash are required.");
  const built = await api.cloud(cloud, candidate.repository);
  if (built.run?.head_sha !== cloud.sourceSha || built.run.path !== ".github/workflows/cloud-home-image.yml" || built.run.status !== "completed" || built.run.conclusion !== "success" || hash(built.receiptBytes) !== cloud.receiptSha256) throw new Error("Cloud image build provenance could not be verified.");
  const image = JSON.parse(built.receiptBytes.toString("utf8"));
  const pins = providerPins(built.dockerfile);
  if (image.schemaVersion !== 1 || image.sourceSha !== cloud.sourceSha || image.repository !== candidate.repository || image.runId !== String(cloud.buildRunId) || image.imageDigest !== cloud.imageDigest || ["claude", "codex"].some(provider => image.providerVersions?.[provider] !== cloud.providerVersions[provider] || pins[provider] !== cloud.providerVersions[provider])) throw new Error("Cloud image receipt, installed providers and source pins do not agree.");
  return { reviewedSources: sources, ascBuildId: build.id, easBuildId: eas.id, cloudImageDigest: image.imageDigest };
}
